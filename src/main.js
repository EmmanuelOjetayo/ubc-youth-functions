import { Client, Databases, ID, Query } from 'node-appwrite';

export default async function ({ req, res, log, error }) {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  const TEAMS = ["OPAJOBI", "ABIMBOLA", "ABIOLA", "UBC"];
  const BUSES = ["1", "2", "3", "4", "5"]; 
  const TARGET_FEE = 4000;
  

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    
    // --- 1. FLUTTERWAVE SECURITY CHECK ---
    // If it's a webhook, verify the secret hash you set in the FLW dashboard
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    // --- 2. DATA DETECTION (The Switch) ---
    let transactionId, camperId, txRef;

    // Webhook detection
    if (signature && signature === secretHash) {
      transactionId = body.id; // Flutterwave ID
      txRef = body.tx_ref;
      // Backup: Try to get camperId from meta or from the tx_ref string we built
      camperId = body.meta?.camper_id || txRef.split('-')[1];
      log(`WEBHOOK: Validated ${txRef} for Camper ${camperId}`);
    } else {
      // Manual/Frontend call detection
      transactionId = body.transaction_id;
      txRef = body.tx_ref;
      camperId = body.camperId || txRef?.split('-')[1];
      log(`MANUAL: Processing ${txRef} for Camper ${camperId}`);
    }

    if (!transactionId || !camperId) {
      return res.json({ success: false, message: "Missing Transaction ID or Camper ID" });
    }

    // --- 3. IDEMPOTENCY CHECK ---
    const existing = await databases.listDocuments(
      process.env.DATABASE_ID, 
      process.env.PAYMENTS_COLLECTION, 
      [Query.equal('reference', txRef)]
    );

    if (existing.total > 0) {
      return res.json({ success: true, message: "Transaction already synced" });
    }

    // --- 4. VERIFY WITH FLUTTERWAVE (Server-to-Server) ---
    const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const flwData = await flwRes.json();
    
    const grossAmount = parseFloat(flwData.data.amount);
    const flwFee = parseFloat(flwData.data.app_fee || 0);


    if (flwData.status !== 'success' || flwData.data.status !== 'successful') {
      return res.json({ success: false, message: "Flutterwave verification failed" });
    }

    // --- 5. AMOUNT CALCULATION ---
    // Flutterwave amount is already in Naira
    const netAmount = parseFloat(grossAmount - flwFee);

    // --- 6. FETCH & UPDATE CAMPER ---
    const camper = await databases.getDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId);
    const newBalance = parseFloat(camper.amount_paid || 0) + netAmount;

    let updatePayload = {
        amount_paid: newBalance,
        status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // --- 7. LOGISTICS ASSIGNMENT ---
    if (newBalance >= TARGET_FEE && !camper.team) {
        const globalPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.notEqual("team", ""),
            Query.limit(1)
        ]);
        
        const genderPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.equal("gender", camper.gender),
            Query.notEqual("bed_no", ""),
            Query.limit(1)
        ]);

        updatePayload.team = TEAMS[globalPaid.total % TEAMS.length];
        updatePayload.bus_no = BUSES[globalPaid.total % BUSES.length];
        
        const prefix = (camper.gender === "Male" || camper.gender === "M") ? "M" : "F";
        updatePayload.bed_no = `${prefix}-${(genderPaid.total + 1).toString().padStart(3, '0')}`;
    }

    // --- 8. EXECUTE DATABASE UPDATES ---
    await databases.updateDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId, updatePayload);

    await databases.createDocument(process.env.DATABASE_ID, process.env.PAYMENTS_COLLECTION, ID.unique(), {
        camperId: camperId,
        amount: netAmount,
        reference: txRef,
        date: new Date().toISOString() 
    });

    return res.json({ success: true, message: "Wallet Synced", credited: netAmount });

  } catch (err) {
    error(err.message);
    return res.json({ success: false, message: err.message }, 500);
  }
}
