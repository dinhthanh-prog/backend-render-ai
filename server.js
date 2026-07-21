require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const PayOS = require('@payos/node');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 1. CẤU HÌNH SUPABASE & PAYOS (TỰ ĐỘNG LÀM SẠCH MÃ KEY)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let payos = null;
try {
    const clientId = (process.env.PAYOS_CLIENT_ID || "").trim();
    const apiKey = (process.env.PAYOS_API_KEY || "").trim();
    const checksumKey = (process.env.PAYOS_CHECKSUM_KEY || "").trim();

    console.log("🔑 [PAYOS INIT] Client ID length:", clientId.length);

    payos = new PayOS(clientId, apiKey, checksumKey);
} catch (err) {
    console.error("⚠️ Cảnh báo khởi tạo PayOS:", err.message);
}
// 2. QUY ĐỔI TIỀN SANG LƯỢT RENDER
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

// 4. API KIỂM TRA SỐ DƯ
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

// 💳 5. API TẠO MÃ QR PAYOS ĐỘNG
app.post('/api/payos/create-payment-link', async (req, res) => {
    try {
        if (!payos) {
            return res.status(500).json({ success: false, error: "Chưa cấu hình đủ 3 Mã Key PayOS trên Render Environment!" });
        }

        const { userId, email, price } = req.body;
        console.log("📥 [PAYOS CREATE LINK REQ]:", { userId, email, price });

        if (!price || isNaN(price)) {
            return res.status(400).json({ success: false, error: "Số tiền không hợp lệ!" });
        }

        const orderCode = Math.floor(100000 + Math.random() * 900000) + Number(String(Date.now()).slice(-5));

        let cleanRef = "";
        if (userId) {
            cleanRef = String(userId);
        } else if (email && email !== "") {
            cleanRef = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, "");
        } else {
            cleanRef = "KHACH";
        }

        const description = `AI ${cleanRef}`.slice(0, 25);

        const body = {
            orderCode: orderCode,
            amount: Number(price),
            description: description,
            cancelUrl: "https://dt3dmodel.com",
            returnUrl: "https://dt3dmodel.com"
        };

        const paymentLinkRes = await payos.createPaymentLink(body);
        
        return res.json({
            success: true,
            qrCode: paymentLinkRes.qrCode,
            orderCode: orderCode,
            description: description
        });

    } catch (error) {
        console.error("❌ Lỗi PayOS Create Link:", error);
        return res.status(500).json({ 
            success: false, 
            error: error.message || "Lỗi khởi tạo thanh toán PayOS" 
        });
    }
});

// 🔔 6. WEBHOOK PAYOS TỰ ĐỘNG CỘNG LƯỢT
app.post('/api/webhook/payos', async (req, res) => {
    try {
        console.log("👉 [PAYOS WEBHOOK RAW]:", req.body);

        if (!req.body) {
            return res.json({ success: true, message: "Empty body" });
        }

        let webhookData = null;

        if (payos) {
            try {
                webhookData = payos.verifyPaymentWebhookData(req.body);
            } catch (vErr) {
                console.log("⚠️ Nhận tin nhắn Ping/Test từ PayOS:", vErr.message);
                return res.json({ success: true, message: "Webhook active" });
            }
        }

        if (webhookData) {
            const amount = webhookData.amount;
            const description = webhookData.description || "";
            const creditsToAdd = calculateCredits(amount);

            console.log(`💰 Giao dịch thật: ${amount} VNĐ - Nội dung: "${description}"`);

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

                    console.log(`🎉 [PAYOS SUCCESS] Đã cộng ${creditsToAdd} Lượt cho User ID ${targetUser.id}. Số dư mới: ${newCredits}`);
                }
            }
        }
        return res.json({ success: true });
    } catch (err) {
        console.error("❌ Lỗi xử lý Webhook PayOS:", err.message);
        return res.json({ success: true });
    }
});

app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`✅ [SERVER RENDER AI - PAYOS] Đang chạy tại cổng ${PORT}`);
    console.log(`=============================================`);
});