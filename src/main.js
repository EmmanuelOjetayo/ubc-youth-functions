import { Client, Databases, ID, Query } from 'node-appwrite';

export default async function ({ req, res, log, error }) {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  const TEAMS = ["OPAJOBI", "ABIMBOLA", "ABIOLA", "UBC"];
  const BUSES = ["1", "2", "3", "4", "5"];
  const TARGET_FEE = 5000; // ✅ Matches frontend

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    let transactionId, camperId, txRef;

    // --- 1. DATA DETECTION ---
    if (signature && signature === secretHash) {
      transactionId = (body.id || body.data?.id)?.toString();
      txRef = body.tx_ref || body.data?.tx_ref;
      camperId = body.meta?.camper_id || (txRef?.includes('-') ? txRef.split('-')[1] : null);
      log(`[WEBHOOK] TX: ${txRef} | Camper: ${camperId}`);
    } else {
      transactionId = body.transaction_id?.toString();
      txRef = body.tx_ref;
      camperId = body.camperId || (txRef?.includes('-') ? txRef.split('-')[1] : null);
      log(`[MANUAL] TX: ${txRef} | Camper: ${camperId}`);
    }

    if (!transactionId || !camperId) {
      error(`[CRITICAL] Missing IDs. TX_ID: ${transactionId}, Camper: ${camperId}`);
      return res.json({ success: false, message: "Incomplete transaction data" });
    }

    // --- 2. VERIFY WITH FLUTTERWAVE ---
    const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const flwData = await flwRes.json();
    if (flwData.status !== 'success' || flwData.data.status !== 'successful') {
      log(`[FAILED] FLW Verification for TX: ${transactionId}`);
      return res.json({ success: false, message: "Flutterwave verification failed" });
    }

    // ✅ Safe net amount with floor guard
    const grossAmount = parseFloat(flwData.data.amount || 0);
    const flwFee = parseFloat(flwData.data.app_fee || 0);
    const netAmount = Math.max(Math.floor(grossAmount - flwFee), 0);

    if (netAmount === 0) {
      error(`[CRITICAL] netAmount is 0. Gross: ${grossAmount}, Fee: ${flwFee}`);
      return res.json({ success: false, message: "Invalid net amount calculated" });
    }

    // --- 3. IDEMPOTENCY LOCK (FLW TX ID as Document ID) ---
    try {
      await databases.createDocument(
        process.env.DATABASE_ID,
        process.env.PAYMENTS_COLLECTION,
        transactionId, // Hard unique lock
        {
          camperId,
          amount: netAmount,
          reference: txRef,
          date: new Date().toISOString()
        }
      );
      log(`[LOCKED] Payment record created: ${transactionId}`);
    } catch (e) {
      if (e.code === 409) {
        log(`[DUPLICATE] Blocked for TX: ${transactionId}`);
        return res.json({ success: true, message: "Transaction already processed" });
      }
      throw e;
    }

    // --- 4. FETCH & UPDATE CAMPER WALLET ---
    const camper = await databases.getDocument(
      process.env.DATABASE_ID, 
      process.env.CAMPERS_COLLECTION, 
      camperId
    );
    const newBalance = parseFloat(camper.amount_paid || 0) + netAmount;

    let updatePayload = {
      amount_paid: newBalance,
      status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // --- 5. LOGISTICS ASSIGNMENT ---
    if (newBalance >= TARGET_FEE && !camper.team) {
      const globalPaid = await databases.listDocuments(
        process.env.DATABASE_ID, 
        process.env.CAMPERS_COLLECTION,
        [Query.notEqual("team", ""), Query.limit(1), Query.select(['$id'])]
      );

      const genderPaid = await databases.listDocuments(
        process.env.DATABASE_ID, 
        process.env.CAMPERS_COLLECTION,
        [
          Query.equal("gender", camper.gender),
          Query.notEqual("bed_no", ""),
          Query.limit(1),
          Query.select(['$id'])
        ]
      );

      updatePayload.team = TEAMS[globalPaid.total % TEAMS.length];
      updatePayload.bus_no = BUSES[globalPaid.total % BUSES.length];

      // ✅ Find a free bed (collision-safe)
      const prefix = (camper.gender === "Male" || camper.gender === "M") ? "M" : "F";
      let bedNum = genderPaid.total + 1;
      let bedAssigned = false;

      while (!bedAssigned) {
        const candidate = `${prefix}-${bedNum.toString().padStart(3, '0')}`;
        const bedCheck = await databases.listDocuments(
          process.env.DATABASE_ID,
          process.env.CAMPERS_COLLECTION,
          [Query.equal("bed_no", candidate), Query.limit(1), Query.select(['$id'])]
        );
        if (bedCheck.total === 0) {
          updatePayload.bed_no = candidate;
          bedAssigned = true;
        }
        bedNum++;
      }

      log(`[LOGISTICS] Camper ${camperId} → Team: ${updatePayload.team} | Bus: ${updatePayload.bus_no} | Bed: ${updatePayload.bed_no}`);
    }

    // --- 6. SAVE TO DB ---
    await databases.updateDocument(
      process.env.DATABASE_ID, 
      process.env.CAMPERS_COLLECTION, 
      camperId, 
      updatePayload
    );

    log(`[COMPLETE] Camper: ${camperId} | New Balance: ₦${newBalance}`);
    return res.json({ success: true, message: "Wallet Synced", credited: netAmount });

  } catch (err) {
    error(`[ERROR] ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
}
