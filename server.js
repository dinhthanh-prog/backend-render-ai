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

// 💳 5. API TẠO MÃ QR PAYOS ĐỘNG (ĐÃ TỐI ƯU CHỐNG LỖI LENGTH)
app.post('/api/payos/create-payment-link', async (req, res) => {
    try {
        const { userId, email, price } = req.body;
        console.log("📥 [PAYOS CREATE LINK REQ]:", { userId, email, price });

        if (!price || isNaN(price)) {
            return res.status(400).json({ success: false, error: "Số tiền không hợp lệ!" });
        }

        // Tạo orderCode ngẫu nhiên dạng số nguyên chuẩn
        const orderCode = Math.floor(100000 + Math.random() * 900000) + Number(String(Date.now()).slice(-5));

        // Trích xuất mã định danh ngắn gọn không dấu
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

        console.log("🚀 Đang gửi yêu cầu tạo QR sang PayOS:", body);

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
            error: error.message || "Lỗi khởi tạo thanh toán PayOS (Kiểm tra lại Key trên Render)" 
        });
    }
});

// 🔔 6. WEBHOOK PAYOS TỰ ĐỘNG CỘNG LƯỢT (ĐÃ XỬ LÝ LỖI TEST PING)
app.post('/api/webhook/payos', async (req, res) => {
    try {
        console.log("👉 [PAYOS WEBHOOK RAW]:", req.body);

        if (!req.body) {
            return res.json({ success: true, message: "Empty body" });
        }

        let webhookData = null;

        // Bọc riêng Verify để không bị lỗi khi PayOS bấm nút "Lưu / Kiểm tra"
        try {
            webhookData = payos.verifyPaymentWebhookData(req.body);
        } catch (vErr) {
            console.log("⚠️ Nhận tin nhắn Ping/Test từ PayOS:", vErr.message);
            // Luôn trả về success: true để PayOS xác nhận Webhook URL đang hoạt động tốt!
            return res.json({ success: true, message: "Webhook active" });
        }

        // Nếu là giao dịch chuyển tiền THẬT (Verify thành công)
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