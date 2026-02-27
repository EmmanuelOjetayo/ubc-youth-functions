import { Client, Databases, ID, Query } from 'node-appwrite';

export default async function (context) {
  const { req, res, log, error } = context;

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
    
    // Support for both Frontend manual trigger and Webhook
    const reference = body.reference || body.data?.reference;
    const camperId = body.camperId || body.data?.metadata?.custom_fields?.find(f => f.variable_name === 'camper_id')?.value;

    if (!reference || !camperId) {
       log("Error: Missing reference or camperId");
       return res.json({ success: false, message: "Missing reference or camperId" }, 400);
    }

    // --- 1. IDEMPOTENCY (Double Payment Protection) ---
    const existingPayment = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.PAYMENTS_COLLECTION,
      [Query.equal('reference', reference), Query.limit(1)]
    );

    if (existingPayment.total > 0) {
      log(`Ref ${reference} already processed.`);
      return res.json({ success: true, message: "Transaction already recorded" });
    }

    // --- 2. PAYSTACK VERIFICATION ---
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== 'success') {
      error(`Verification failed for ref: ${reference}`);
      return res.json({ success: false, message: "Payment not verified" }, 400);
    }

    // --- 3. THE "NET AMOUNT" CALCULATION ---
    // data.amount = Total user paid (Gross)
    // data.fees = What Paystack deducted
    const grossKobo = paystackData.data.amount;
    const feesKobo = paystackData.data.fees;
    
    // Net is the "rest" - what actually hits your bank account
    const netAmount = (grossKobo - feesKobo) / 100;

    // --- 4. FETCH & CALCULATE NEW WALLET BALANCE ---
    const camper = await databases.getDocument(
      process.env.DATABASE_ID, 
      process.env.CAMPERS_COLLECTION, 
      camperId
    );
    
    const previousPaid = parseFloat(camper.amount_paid || 0);
    const newTotalBalance = previousPaid + netAmount;

    let updatePayload = {
        amount_paid: newTotalBalance,
        // Status only turns 'paid' if the NET total hits 4000
        status: newTotalBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // --- 5. LOGISTICS (Only if fully paid and not yet assigned) ---
    if (newTotalBalance >= TARGET_FEE && !camper.team) {
        // Find total count of fully paid campers to rotate teams/buses
        const allPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.greaterThanEqual("amount_paid", TARGET_FEE)
        ]);
        
        // Find count of same-gender paid campers for bed numbering
        const genderPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.equal("gender", camper.gender),
            Query.greaterThanEqual("amount_paid", TARGET_FEE)
        ]);

        const index = allPaid.total; // Use current total as index
        updatePayload.team = TEAMS[index % TEAMS.length];
        updatePayload.bus_no = BUSES[index % BUSES.length];
        
        const prefix = camper.gender === "Male" ? "M" : "F";
        // Bed ID: e.g., M-042
        updatePayload.bed_no = `${prefix}-${(genderPaid.total + 1).toString().padStart(3, '0')}`;
    }

    // --- 6. ATOMIC UPDATES ---
    // Update Camper Document
    await databases.updateDocument(
      process.env.DATABASE_ID, 
      process.env.CAMPERS_COLLECTION, 
      camperId, 
      updatePayload
    );

    // Record Payment (Storing NET amount for accounting)
    await databases.createDocument(
      process.env.DATABASE_ID, 
      process.env.PAYMENTS_COLLECTION, 
      ID.unique(), 
      {
        camperId: camperId,
        amount: netAmount, 
        reference: reference,
        date: new Date().toISOString()
      }
    );

    log(`Success: ${camper.name} | Net Credited: ₦${netAmount} | New Balance: ₦${newTotalBalance}`);
    
    return res.json({ success: true, balance: newTotalBalance });

  } catch (err) {
    error(`CRITICAL ERROR: ${err.message}`);
    return res.json({ success: false, message: "Internal processing error" }, 500);
  }
}
