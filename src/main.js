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

    // 2. UPDATED REVENUE LOGIC: Deduct Fees
    // amount = what user paid | fees = what Paystack charged
    // We calculate the NET amount to add to their wallet balance
    const netAmount = (paystackData.data.amount - paystackData.data.fees) / 100;

    // 3. FETCH CAMPER
    const camper = await databases.getDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId);
    
    // Use the netAmount here so the camper only gets credited for the "Deposit" part
    const newBalance = parseFloat(camper.amount_paid || 0) + netAmount;

    let updatePayload = {
        amount_paid: newBalance,
        status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // 4. STRICT GENDER-BASED BED SORTING (Only if they just hit the target)
    if (newBalance >= TARGET_FEE && !camper.team) {
        const globalPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.notEqual("team", ""),
            Query.limit(1) // We only need the total count
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

    // 5. UPDATE DATABASE
    await databases.updateDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId, updatePayload);

    // 6. LOG TRANSACTION (Record the net amount received)
    await databases.createDocument(process.env.DATABASE_ID, process.env.PAYMENTS_COLLECTION, ID.unique(), {
        camperId: camperId,
        amount: netAmount.toString(), 
        reference: reference,
        // Ensure your collection has a 'date' or '$createdAt' field
        date: new Date().toISOString() 
    });

    return res.json({ success: true, data: updatePayload, credited: netAmount });

  } catch (err) {
    error(err.message);
    return res.json({ success: false, message: err.message }, 500);
  }
}
