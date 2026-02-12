import { Client, Databases, ID } from 'node-appwrite';

export default async function ({ req, res, log, error }) {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { reference, camperId } = body;

    if (!reference || !camperId) {
      error("Missing reference or camperId");
      return res.json({ success: false, message: "Invalid request data" });
    }

    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { 
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== 'success') {
      return res.json({ success: false, message: "Payment not verified" });
    }

    const rawAmount = paystackData.data.amount / 100;
    const netDeposit = Math.floor((rawAmount * (1 - 0.015)) - 100);

    const camper = await databases.getDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId);
    const newBalance = parseFloat(camper.amount_paid || 0) + netDeposit;

    await databases.updateDocument(process.env.DATABASE_ID, process.env.CAMPERS_COLLECTION, camperId, {
        amount_paid: newBalance,
        status: newBalance >= 4000 ? 'paid' : 'pending'
    });

    await databases.createDocument(process.env.DATABASE_ID, process.env.PAYMENTS_COLLECTION, ID.unique(), {
        camperId: camperId,
        amount: netDeposit,
        reference: reference,
        date: new Date().toISOString()
    });

    return res.json({ success: true, message: "Wallet updated!" });

  } catch (err) {
    error("Error: " + err.message);
    return res.json({ success: false, message: err.message });
  }
}
