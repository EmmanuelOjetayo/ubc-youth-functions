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
    
    // Support both Frontend call and Paystack Webhook traffic
    const reference = body.reference || body.data?.reference;
    // Extract camperId from body or from Paystack's nested metadata
    const camperId = body.camperId || body.data?.metadata?.custom_fields?.find(f => f.variable_name === 'camper_id')?.value;

    if (!reference || !camperId) {
       log("Error: Missing reference or camperId in request");
       return res.json({ success: false, message: "Missing reference or camperId" }, 400);
    }

    // --- 1. DUPLICATE PROTECTION ---
    const existingPayment = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.PAYMENTS_COLLECTION,
      [Query.equal('reference', reference), Query.limit(1)]
    );

    if (existingPayment.total > 0) {
      log(`Duplicate attempt blocked for ref: ${reference}`);
      return res.json({ success: true, message: "Already processed" });
    }

    // --- 2. VERIFY WITH PAYSTACK ---
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== 'success') {
      error(`Paystack verification failed for ref: ${reference}`);
      return res.json({ success: false, message: "Payment verification failed" }, 400);
    }

    // --- 3. NET DROP CALCULATION ---
    // Gross Amount (what user paid) - Fees (what Paystack took) = Net (what hits your bank)
    const grossInKobo = paystackData.data.amount;
    const feesInKobo = paystackData.data.fees;
    const netAmountDrops = (grossInKobo - feesInKobo) / 100; // Convert Kobo to Naira

    // --- 4. FETCH CAMPER & UPDATE BALANCE ---
    const camper = await databases.getDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId);
    
    // Use netAmountDrops for the wallet balance
    const newBalance = parseFloat(camper.amount_paid || 0) + netAmountDrops;

    let updatePayload = {
        amount_paid: newBalance,
        status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // --- 5. LOGISTICS ASSIGNMENT (Syncing logic) ---
    if (newBalance >= TARGET_FEE && !camper.team) {
        // Count how many people have reached the TARGET_FEE already
        const globalPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.greaterThanEqual("amount_paid", TARGET_FEE)
        ]);
        
        const genderPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.equal("gender", camper.gender),
            Query.greaterThanEqual("amount_paid", TARGET_FEE)
        ]);

        updatePayload.team = TEAMS[globalPaid.total % TEAMS.length];
        updatePayload.bus_no = BUSES[globalPaid.total % BUSES.length];
        
        const prefix = camper.gender === "Male" ? "M" : "F";
        // Bed Number based on order of full payment
        updatePayload.bed_no = `${prefix}-${(genderPaid.total + 1).toString().padStart(3, '0')}`;
    }

    // --- 6. ATOMIC UPDATES ---
    // Update the Camper Document
    await databases.updateDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId, updatePayload);

    // Create the Payment Record (recording the NET amount for clean books)
    await databases.createDocument(process.env.DATABASE_ID, process.env.PAYMENTS_COLLECTION, ID.unique(), {
        camperId: camperId,
        amount: netAmountDrops, // Storing what actually dropped in the bank
        reference: reference,
        date: new Date().toISOString()
    });

    log(`Success: ${camper.name} credited with Net: ₦${netAmountDrops}. New Balance: ₦${newBalance}`);
    
    return res.json({ success: true, data: updatePayload });

  } catch (err) {
    error(`CRITICAL ERROR: ${err.message}`);
    return res.json({ success: false, message: "Internal Server Error" }, 500);
  }
}
