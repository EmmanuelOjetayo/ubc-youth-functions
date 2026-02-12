import { Client, Databases, ID, Query } from 'node-appwrite';

export default async function ({ req, res, log, error }) {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  // --- SENIOR ARCHITECT CONFIGURATION ---
  const TEAMS = ["OPAJOBI", "ABIMBOLA", "ABIOLA", "UBC"];
  const BUSES = ["1", "2", "3", "4", "5"]; 
  const FEMALE_BED_LIMIT = 150;
  const MALE_BED_LIMIT = 100;
  const TARGET_FEE = 4000;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { reference, camperId } = body;

    if (!reference || !camperId) {
      error("Missing reference or camperId");
      return res.json({ success: false, message: "Invalid request data" });
    }

    // 1. VERIFY WITH PAYSTACK
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { 
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== 'success') {
      return res.json({ success: false, message: "Payment verification failed at Paystack" });
    }

    // 2. CALCULATE DEPOSIT (Removing fees logic)
    const rawAmount = paystackData.data.amount / 100;
    const netDeposit = Math.floor((rawAmount * (1 - 0.015)) - 100);

    // 3. FETCH CURRENT CAMPER STATE
    const camper = await databases.getDocument(
      process.env.DATABASE_ID, 
      process.env.CAMPERS_COLLECTION, 
      camperId
    );
    
    const newBalance = parseFloat(camper.amount_paid || 0) + netDeposit;
    log(`Camper ${camper.name} new balance: ₦${newBalance}`);

    // 4. PREPARE THE ATOMIC UPDATE PACKAGE
    let updatePayload = {
        amount_paid: newBalance,
        status: newBalance >= TARGET_FEE ? 'paid' : 'pending'
    };

    // 5. RUN ALLOCATION LOGIC (Only if newly paid and not yet assigned)
    if (newBalance >= TARGET_FEE && !camper.team) {
        log("Target reached. Initializing Round Robin Allocation...");

        // A. Get Global Count (for Team/Bus balance)
        const totalAssigned = await databases.listDocuments(
            process.env.DATABASE_ID, 
            process.env.CAMPERS_COLLECTION, 
            [Query.notEqual("team", "")]
        );
        const globalIndex = totalAssigned.total;

        // B. Get Gender Count (for Bed availability)
        const genderAssigned = await databases.listDocuments(
            process.env.DATABASE_ID, 
            process.env.CAMPERS_COLLECTION, 
            [
                Query.equal("gender", camper.gender),
                Query.notEqual("bed_no", "")
            ]
        );
        const genderCount = genderAssigned.total;
        const currentLimit = camper.gender === "Male" ? MALE_BED_LIMIT : FEMALE_BED_LIMIT;

        // C. CAPACITY CHECK
        if (genderCount >= currentLimit) {
            log(`ALERT: ${camper.gender} capacity reached! Assigning to Waitlist.`);
            updatePayload.team = "WAITLIST";
            updatePayload.bus_no = "N/A";
            updatePayload.bed_no = "WAITLIST-FULL";
        } else {
            // D. PERFORM ROUND ROBIN
            updatePayload.team = TEAMS[globalIndex % TEAMS.length];
            updatePayload.bus_no = BUSES[globalIndex % BUSES.length];
            
            const prefix = camper.gender === "Male" ? "M" : "F";
            const bedNum = (genderCount + 1).toString().padStart(3, '0');
            updatePayload.bed_no = `${prefix}-${bedNum}`;
            
            log(`Allocation complete: Team ${updatePayload.team}, Bus ${updatePayload.bus_no}, Bed ${updatePayload.bed_no}`);
        }
    }

    // 6. COMMIT CHANGES TO CAMPERS COLLECTION (ONE ATOMIC WRITE)
    await databases.updateDocument(
        process.env.DATABASE_ID, 
        process.env.CAMPERS_COLLECTION, 
        camperId, 
        updatePayload
    );

    // 7. RECORD TRANSACTION IN LEDGER
    await databases.createDocument(
        process.env.DATABASE_ID, 
        process.env.PAYMENTS_COLLECTION, 
        ID.unique(), 
        {
            camperId: camperId,
            amount: netDeposit,
            reference: reference,
            date: new Date().toISOString()
        }
    );

    return res.json({ 
        success: true, 
        message: "Logistics synchronized!", 
        data: updatePayload 
    });

  } catch (err) {
    error("Critical Function Error: " + err.message);
    return res.json({ success: false, message: err.message }, 500);
  }
}
