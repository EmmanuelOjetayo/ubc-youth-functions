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
    const { reference, camperId } = body;

    // 1. VERIFY WITH PAYSTACK
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== 'success') {
      return res.json({ success: false, message: "Payment verification failed" });
    }

    // 2. PRODUCTION REVENUE LOGIC (No fee deduction)
    const rawAmount = paystackData.data.amount / 100; // Just convert Kobo to Naira

    // 3. FETCH CAMPER
    const camper = await databases.getDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId);
    const newBalance = parseFloat(camper.amount_paid || 0) + rawAmount;

    let updatePayload = {
        amount_paid: newBalance,
        status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // 4. STRICT GENDER-BASED BED SORTING
    if (newBalance >= TARGET_FEE && !camper.team) {
        // Get Team/Bus index
        const globalPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [Query.notEqual("team", "")]);
        
        // Get specific Gender count for Bed sorting
        const genderPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.equal("gender", camper.gender),
            Query.notEqual("bed_no", "")
        ]);

        updatePayload.team = TEAMS[globalPaid.total % TEAMS.length];
        updatePayload.bus_no = BUSES[globalPaid.total % BUSES.length];
        
        const prefix = camper.gender === "Male" ? "M" : "F";
        // Bed logic: Sorts based on how many of that gender have paid before them
        updatePayload.bed_no = `${prefix}-${(genderPaid.total + 1).toString().padStart(3, '0')}`;
    }

    await databases.updateDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId, updatePayload);

    await databases.createDocument(process.env.DATABASE_ID, process.env.PAYMENTS_COLLECTION, ID.unique(), {
        camperId: camperId,
        amount: rawAmount,
        reference: reference,
        date: new Date().toISOString()
    });

    return res.json({ success: true, data: updatePayload });

  } catch (err) {
    error(err.message);
    return res.json({ success: false, message: err.message }, 500);
  }
}
