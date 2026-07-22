const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const PayOS = require('@payos/node');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 🌐 TẢI GIAO DIỆN REMOTE CHO SKETCHUP
app.get('/ui', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui.html'));
});

const PORT = process.env.PORT || 3000;

// 1. CẤU HÌNH SUPABASE & PAYOS
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

// 🎯 5. API TRỪ LƯỢT REAL-TIME TRÊN SUPABASE (Đã đồng bộ hoá với Giao Diện)
app.post('/api/render/user/deduct', async (req, res) => {
  try {
    // Sửa lại để nhận tham số "cost" thay vì "amount" để khớp với code HTML
    const { email, cost, amount } = req.body;
    const deductValue = parseFloat(cost || amount);

    if (!email || isNaN(deductValue)) {
        return res.status(400).json({ success: false, error: 'Thiếu email hoặc số lượt trừ' });
    }

    const { data: user, error: fetchErr } = await supabase
      .from('users_tokens_render')
      .select('credits')
      .eq('email', email)
      .single();

    if (fetchErr || !user) return res.status(404).json({ success: false, error: 'Không tìm thấy user' });

    const newCredits = Math.max(0, user.credits - deductValue);

    const { data: updatedUser, error: updateErr } = await supabase
      .from('users_tokens_render')
      .update({ credits: newCredits })
      .eq('email', email)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });

    console.log(`✂️ [TRỪ LƯỢT] User: ${email} | Trừ: ${deductValue} | Còn lại: ${updatedUser.credits}`);
    
    // Trả về từ khóa "newCredits" để giao diện đọc được và update UI
    return res.json({ success: true, newCredits: updatedUser.credits });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 💳 6. API TẠO MÃ QR PAYOS ĐỘNG
app.post('/api/payos/create-payment-link', async (req, res) => {
    try {
        if (!payos) {
            return res.status(500).json({ success: false, error: "Chưa cấu hình đủ Mã Key PayOS trên Render!" });
        }

        const { userId, email, price } = req.body;
        if (!price || isNaN(price)) {
            return res.status(400).json({ success: false, error: "Số tiền không hợp lệ!" });
        }

        const orderCode = Math.floor(100000 + Math.random() * 900000) + Number(String(Date.now()).slice(-5));
        let cleanRef = userId ? String(userId) : (email ? email.split('@')[0].replace(/[^a-zA-Z0-9]/g, "") : "KHACH");
        const description = `AI ${cleanRef}`.slice(0, 25);

        const body = {
            orderCode: orderCode,
            amount: Number(price),
            description: description,
            cancelUrl: "https://dt3dmodel.com",
            returnUrl: "https://dt3dmodel.com"
        };

        const paymentLinkRes = await payos.createPaymentLink(body);
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(paymentLinkRes.qrCode)}`;

        return res.json({
            success: true,
            qrCode: qrImageUrl,
            orderCode: orderCode,
            description: description
        });

    } catch (error) {
        console.error("❌ Lỗi PayOS Create Link:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 🔔 7. WEBHOOK PAYOS TỰ ĐỘNG CỘNG LƯỢT
app.post('/api/webhook/payos', async (req, res) => {
    try {
        if (!req.body) return res.json({ success: true, message: "Empty body" });

        let webhookData = null;
        if (payos) {
            try {
                webhookData = payos.verifyPaymentWebhookData(req.body);
            } catch (vErr) {
                return res.json({ success: true, message: "Webhook active" });
            }
        }

        if (webhookData) {
            const amount = webhookData.amount;
            const description = webhookData.description || "";
            const creditsToAdd = calculateCredits(amount);

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

// 🚀 KHỞI CHẠY SERVER
app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`✅ [SERVER RENDER AI - PAYOS] Đang chạy tại cổng ${PORT}`);
    console.log(`=============================================`);
});