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
    
    // 1. DATA DETECTION (The Switch)
    let reference, camperId;

    if (body.event === 'charge.success') {
      // Logic for PAYSTACK WEBHOOK
      reference = body.data.reference;
      // Pulling the camper_id we hid in the metadata custom_fields
      const metadata = body.data.metadata?.custom_fields || [];
      camperId = metadata.find(f => f.variable_name === 'camper_id')?.value;
      log(`WEBHOOK TRIGGERED: Ref ${reference} for Camper ${camperId}`);
    } else {
      // Logic for MANUAL FRONTEND CALL
      reference = body.reference;
      camperId = body.camperId;
      log(`MANUAL TRIGGERED: Ref ${reference} for Camper ${camperId}`);
    }

    if (!reference || !camperId) {
      return res.json({ success: false, message: "Missing Reference or Camper ID" });
    }

    // 2. IDEMPOTENCY CHECK (Safety Net)
    // Don't process the same reference twice if Webhook and Manual hit together
    const existing = await databases.listDocuments(
      process.env.DATABASE_ID, 
      process.env.PAYMENTS_COLLECTION, 
      [Query.equal('reference', reference)]
    );

    if (existing.total > 0) {
      return res.json({ success: true, message: "Transaction already processed" });
    }

    // 3. VERIFY WITH PAYSTACK (Official Proof)
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== 'success') {
      return res.json({ success: false, message: "Payment verification failed" });
    }

    // 4. NET REVENUE CALCULATION
    const netAmount = (paystackData.data.amount - paystackData.data.fees) / 100;

    // 5. FETCH & UPDATE CAMPER
    const camper = await databases.getDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId);
    const newBalance = parseFloat(camper.amount_paid || 0) + netAmount;

    let updatePayload = {
        amount_paid: newBalance,
        status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // 6. LOGISTICS ASSIGNMENT (Gender-Based)
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

    // 7. EXECUTE DATABASE UPDATES
    await databases.updateDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId, updatePayload);

    await databases.createDocument(process.env.DATABASE_ID, process.env.PAYMENTS_COLLECTION, ID.unique(), {
        camperId: camperId,
        amount: netAmount,
        reference: reference,
        date: new Date().toISOString() 
    });

    return res.json({ success: true, message: "Wallet Synced", credited: netAmount });

  } catch (err) {
    error(err.message);
    return res.json({ success: false, message: err.message }, 500);
  }
}
