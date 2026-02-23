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

  // OPay Credentials
  const OPAY_MERCHANT_ID = process.env.OPAY_MERCHANT_ID;
  const OPAY_PUBLIC_KEY = process.env.OPAY_PUBLIC_KEY; 

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { reference, camperId } = body;

    // 1. VERIFY WITH OPAY MERCHANT API
    // OPay requires a POST request to their international cashier status endpoint
    const opayRes = await fetch(`https://api.opaycheckout.com/api/v1/international/cashier/status`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${OPAY_PUBLIC_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        orderNo: reference,
        merchantId: OPAY_MERCHANT_ID
      })
    });
    
    const opayData = await opayRes.json();

    // OPay "00000" code means the request was successful
    if (opayData.code !== "00000" || opayData.data.status !== 'SUCCESSFUL') {
      error(`Payment Failed or Pending: ${opayData.message || 'Unknown Error'}`);
      return res.json({ success: false, message: "Payment verification failed" });
    }

    // 2. REVENUE LOGIC
    // OPay status returns the amount in the base unit (Naira), not Kobo.
    const rawAmount = parseFloat(opayData.data.amount); 

    // 3. FETCH CAMPER
    const camper = await databases.getDocument(
      process.env.DATABASE_ID, 
      process.env.CAMPERS_COLLECTION, 
      camperId
    );
    
    const newBalance = parseFloat(camper.amount_paid || 0) + rawAmount;

    let updatePayload = {
        amount_paid: newBalance,
        status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // 4. LOGISTICS ASSIGNMENT (Only if fully paid and not yet assigned)
    if (newBalance >= TARGET_FEE && !camper.team) {
        // Count how many people have been assigned teams already
        const globalPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.notEqual("team", ""),
            Query.limit(1) 
        ]);
        
        // Count how many of this specific gender have beds
        const genderPaid = await databases.listDocuments(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, [
            Query.equal("gender", camper.gender),
            Query.notEqual("bed_no", ""),
            Query.limit(1)
        ]);

        // Assign Team & Bus based on rotation
        updatePayload.team = TEAMS[globalPaid.total % TEAMS.length];
        updatePayload.bus_no = BUSES[globalPaid.total % BUSES.length];
        
        // Prefix-based Bed Logic (M-001, F-001)
        const prefix = camper.gender === "Male" ? "M" : "F";
        const bedIndex = (genderPaid.total + 1).toString().padStart(3, '0');
        updatePayload.bed_no = `${prefix}-${bedIndex}`;
    }

    // 5. ATOMIC UPDATES
    await databases.updateDocument(
      process.env.DATABASE_ID, 
      process.env.CAMPERS_COLLECTION, 
      camperId, 
      updatePayload
    );

    await databases.createDocument(
      process.env.DATABASE_ID, 
      process.env.PAYMENTS_COLLECTION, 
      ID.unique(), 
      {
        camperId: camperId,
        amount: rawAmount.toString(),
        reference: reference,
        date: new Date().toISOString()
      }
    );

    log(`SUCCESS: Verified ₦${rawAmount} for ${camper.name}`);
    return res.json({ success: true, data: updatePayload });

  } catch (err) {
    error(`System Error: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
}
