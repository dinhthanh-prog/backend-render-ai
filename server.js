require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const PayOS = require('@payos/node');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 1. KHỞI TẠO PAYOS & SUPABASE
const payos = new PayOS(
    process.env.PAYOS_CLIENT_ID,
    process.env.PAYOS_API_KEY,
    process.env.PAYOS_CHECKSUM_KEY
);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.get('/', (req, res) => {
    res.send('✅ Server Render AI (PayOS + Supabase) đang chạy!');
});

// 2. TÍNH SỐ LƯỢT RENDER
function calculateCredits(amount) {
    if (amount >= 500000) return 625;
    if (amount >= 200000) return 235;
    if (amount >= 100000) return 110;
    if (amount >= 50000) return 50;
    return Math.floor(amount / 1000);
}

// 3. API AUTH GOOGLE
app.post('/api/render/auth/google', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Thiếu Email" });

        const { data: userWallet } = await supabase
            .from('users_tokens_render')
            .select('*')
            .eq('email', email)
            .maybeSingle();

        if (userWallet) {
            return res.json({ id: userWallet.id, email: userWallet.email, credits: userWallet.credits });
        } else {
            const { data: newUser, error: insertErr } = await supabase
                .from('users_tokens_render')
                .insert([{ email: email, credits: 0 }])
                .select()
                .single();

            if (insertErr) return res.status(500).json({ error: insertErr.message });
            return res.json({ id: newUser.id, email: newUser.email, credits: 0 });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 4. API CHECK SỐ DƯ
app.get('/api/render/user/balance', async (req, res) => {
    try {
        const email = req.query.email;
        const { data } = await supabase
            .from('users_tokens_render')
            .select('credits')
            .eq('email', email)
            .single();
        return res.json({ credits: data ? data.credits : 0 });
    } catch (err) {
        return res.status(404).json({ credits: 0 });
    }
});

// 💳 5. API TẠO LINK & MÃ QR THANH TOÁN PAYOS
app.post('/api/payos/create-payment-link', async (req, res) => {
    try {
        const { userId, email, price } = req.body;
        const orderCode = Number(String(Date.now()).slice(-9)); // Tạo mã đơn hàng duy nhất
        const cleanEmail = email ? email.replace(/[^a-zA-Z0-9]/g, "") : "";
        const description = userId ? `AI ${userId}` : `AI ${cleanEmail}`;

        const body = {
            orderCode: orderCode,
            amount: price,
            description: description.slice(0, 25), // PayOS giới hạn 25 ký tự
            cancelUrl: "https://dt3dmodel.com",
            returnUrl: "https://dt3dmodel.com"
        };

        const paymentLinkRes = await payos.createPaymentLink(body);
        return res.json({
            success: true,
            qrCode: paymentLinkRes.qrCode,
            orderCode: orderCode,
            description: body.description
        });
    } catch (error) {
        console.error("❌ Lỗi PayOS Create Link:", error);
        return res.status(500).json({ error: error.message });
    }
});

// 🔔 6. WEBHOOK PAYOS TỰ ĐỘNG CỘNG LƯỢT
app.post('/api/webhook/payos', async (req, res) => {
    try {
        const webhookData = payos.verifyPaymentWebhookData(req.body);
        console.log("👉 [PAYOS WEBHOOK RECEIVED]:", webhookData);

        if (webhookData.code === "00") { // Thanh toán thành công
            const amount = webhookData.amount;
            const description = webhookData.description || "";
            const creditsToAdd = calculateCredits(amount);

            // Bắt mã ID từ mô tả "AI 11"
            const match = description.match(/\bAI\s+([a-zA-Z0-9]+)/i);
            const refCode = match ? match[1].toLowerCase() : "";

            const { data: users } = await supabase.from('users_tokens_render').select('*');

            if (users) {
                const targetUser = users.find(u => {
                    if (!u) return false;
                    const isIdMatch = u.id && u.id.toString() === refCode;
                    const userCleanEmail = u.email ? u.email.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : "";
                    return isIdMatch || userCleanEmail === refCode;
                });

                if (targetUser) {
                    const newCredits = (parseFloat(targetUser.credits) || 0) + creditsToAdd;
                    await supabase
                        .from('users_tokens_render')
                        .update({ credits: newCredits })
                        .eq('id', targetUser.id);

                    console.log(`🎉 [PAYOS SUCCESS] Đã cộng ${creditsToAdd} Lượt cho User ID ${targetUser.id} (${targetUser.email}). Số dư mới: ${newCredits}`);
                }
            }
        }
        return res.json({ success: true });
    } catch (err) {
        console.error("❌ Lỗi Webhook PayOS:", err.message);
        return res.json({ success: false });
    }
});

app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`✅ [SERVER RENDER AI - PAYOS] Đang chạy tại cổng ${PORT}`);
    console.log(`=============================================`);
});