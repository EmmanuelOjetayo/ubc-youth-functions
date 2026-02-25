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
    const camperId = body.camperId || body.data?.metadata?.camper_id;

    if (!reference || !camperId) {
       return res.json({ success: false, message: "Missing reference or camperId" }, 400);
    }

    // --- TRAFFIC & DUPLICATE PROTECTION ---
    // 1. Check if this payment was ALREADY processed (Prevents double-counting)
    const existingPayment = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.PAYMENTS_COLLECTION,
      [Query.equal('reference', reference), Query.limit(1)]
    );

    if (existingPayment.total > 0) {
      log(`Duplicate attempt blocked for ref: ${reference}`);
      return res.json({ success: true, message: "Already processed" });
    }

    // 2. VERIFY WITH PAYSTACK
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== 'success') {
      return res.json({ success: false, message: "Payment verification failed" }, 400);
    }

    const rawAmount = paystackData.data.amount / 100; 

    // 3. FETCH CAMPER & UPDATE
    const camper = await databases.getDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId);
    const newBalance = parseFloat(camper.amount_paid || 0) + rawAmount;

    let updatePayload = {
        amount_paid: newBalance,
        status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // 4. LOGISTICS ASSIGNMENT (Only if fully paid and not yet assigned)
    if (newBalance >= TARGET_FEE && !camper.team) {
        // Query only "paid" users to calculate next index
        const globalPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.greaterThanEqual("amount_paid", TARGET_FEE),
            Query.limit(1) // We just need the 'total'
        ]);
        
        const genderPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.equal("gender", camper.gender),
            Query.greaterThanEqual("amount_paid", TARGET_FEE),
            Query.limit(1)
        ]);

        updatePayload.team = TEAMS[globalPaid.total % TEAMS.length];
        updatePayload.bus_no = BUSES[globalPaid.total % BUSES.length];
        
        const prefix = camper.gender === "Male" ? "M" : "F";
        // Bed Number is count of gender-specific paid campers + 1
        updatePayload.bed_no = `${prefix}-${(genderPaid.total + 1).toString().padStart(3, '0')}`;
    }

    // 5. UPDATE DATABASE (Atomic-like update)
    await databases.updateDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId, updatePayload);

    // 6. RECORD THE TRANSACTION (Final checkmark)
    await databases.createDocument(process.env.DATABASE_ID, process.env.PAYMENTS_COLLECTION, ID.unique(), {
        camperId: camperId,
        amount: rawAmount,
        reference: reference,
        date: new Date().toISOString()
    });

    log(`Success: ${camper.name} paid ${rawAmount}. Total: ${newBalance}`);
    return res.json({ success: true, data: updatePayload });

  } catch (err) {
    error(`CRITICAL ERROR: ${err.message}`);
    return res.json({ success: false, message: "Internal Server Error" }, 500);
  }
}
