const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const PayOS = require('@payos/node');

const app = express();
// ✅ MỚI: Mở rộng giới hạn cho phép gửi ảnh Base64 nặng đến 50MB
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// 🌐 TẢI GIAO DIỆN REMOTE CHO SKETCHUP
app.get('/ui', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui.html'));
});

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
// 🌐 TẢI GIAO DIỆN REMOTE CHO SKETCHUP PLUGIN (AUTO UPDATE)
app.get('/ui', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui.html'));
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

// 💳 5. API TẠO MÃ QR PAYOS ĐỘNG (CHUẨN TRACKING CỦA PAYOS)
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

        // Khởi tạo link thanh toán trên PayOS
        const paymentLinkRes = await payos.createPaymentLink(body);
        
        // 🎯 DÙNG CHUỖI MÃ HOÁ GỐC CỦA PAYOS (CHỨA MÃ TRACKING) ĐỂ TẠO ẢNH QR
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(paymentLinkRes.qrCode)}`;

        return res.json({
            success: true,
            qrCode: qrImageUrl, // Ảnh QR giờ đã chứa đầy đủ dữ liệu nhận diện của PayOS
            orderCode: orderCode,
            description: description
        });

    } catch (error) {
        console.error("❌ Lỗi PayOS Create Link:", error);
        return res.status(500).json({ success: false, error: error.message });
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
// ======================================================
// 🚀 API PHÓNG CẤP ẢNH 4K BẰNG MAGNIFIC AI
// ======================================================
app.post('/api/upscale-4k', async (req, res) => {
    try {
        const { email, imageUrl } = req.body;

        if (!email || !imageUrl) {
            return res.status(400).json({ error: "Thiếu thông tin Email hoặc Ảnh cần nâng cấp!" });
        }

        const COST_CREDITS = 15; // Phí 15 lượt

        // 1. Kiểm tra số dư lượt của User trong Supabase
        const { data: user, error: userErr } = await supabase
            .from('users_tokens_render')
            .select('credits')
            .eq('email', email)
            .single();

        if (userErr || !user) {
            return res.status(404).json({ error: "Không tìm thấy tài khoản người dùng!" });
        }

        if (user.credits < COST_CREDITS) {
            return res.status(400).json({ 
                error: `Tài khoản không đủ lượt! Cần ${COST_CREDITS} lượt (Số dư: ${user.credits})` 
            });
        }

        const apiKey = process.env.MAGNIFIC_API_KEY || "MS4da1ac36ceac4058b2d8e384e770977e";

        // Làm sạch chuỗi Base64 nếu có prefix
        let cleanBase64 = imageUrl;
        if (cleanBase64.includes('base64,')) {
            cleanBase64 = cleanBase64.split('base64,')[1];
        }

        // 2. Gọi API Magnific Precision V2
        const magnificRes = await fetch("https://api.magnific.com/v1/ai/image-upscaler-precision-v2", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-magnific-api-key": apiKey
            },
            body: JSON.stringify({
                image: cleanBase64,
                scale_factor: 4,
                flavor: "photo"
            })
        });

        const magData = await magnificRes.json();

        if (!magnificRes.ok) {
            console.error("❌ Lỗi Magnific API:", magData);
            return res.status(500).json({ error: magData.message || "Lỗi xử lý Magnific AI" });
        }

        const taskId = magData.data?.task_id;
        if (!taskId) {
            return res.status(500).json({ error: "Không nhận được Task ID từ Magnific!" });
        }

        // 3. Vòng lặp chờ Magnific xử lý xong (Polling task_id)
        let upscaledUrl = null;
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Chờ 2s mỗi lần kiểm tra

            const pollRes = await fetch(`https://api.magnific.com/v1/ai/image-upscaler-precision-v2/${taskId}`, {
                headers: { "x-magnific-api-key": apiKey }
            });
            const pollData = await pollRes.json();

            if (pollData.data?.status === "COMPLETED") {
                upscaledUrl = pollData.data?.generated?.[0];
                break;
            } else if (pollData.data?.status === "FAILED" || pollData.data?.status === "ERROR") {
                return res.status(500).json({ error: "Tiến trình nâng cấp 4K trên Magnific thất bại!" });
            }
        }

        if (!upscaledUrl) {
            return res.status(500).json({ error: "Quá thời gian xử lý 4K (Timeout)!" });
        }

        // 4. Trừ 15 lượt của User trong cơ sở dữ liệu Supabase
        const newCredits = user.credits - COST_CREDITS;
        await supabase
            .from('users_tokens_render')
            .update({ credits: newCredits })
            .eq('email', email);

        console.log(`✅ [NÂNG 4K THÀNH CÔNG] User: ${email} | Trừ 15 lượt | Số dư còn: ${newCredits}`);

        // 5. Trả kết quả về cho Plugin
        return res.json({
            success: true,
            upscaledUrl: upscaledUrl,
            remainingCredits: newCredits
        });

    } catch (err) {
        console.error("❌ Lỗi Server /api/upscale-4k:", err);
        return res.status(500).json({ error: "Lỗi Server: " + err.message });
    }
});
app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`✅ [SERVER RENDER AI - PAYOS] Đang chạy tại cổng ${PORT}`);
    console.log(`=============================================`);
});
// ======================================================
// 🚀 6. API PHÓNG CẤP ẢNH 4K / 8K BẰNG MAGNIFIC AI (FREPIK)
// ======================================================
app.post('/api/upscale-4k', async (req, res) => {
    try {
        const { email, imageUrl } = req.body;

        if (!email || !imageUrl) {
            return res.status(400).json({ error: "Thiếu thông tin Email hoặc URL ảnh cần nâng cấp!" });
        }

        const COST_CREDITS = 15; // Số lượt trừ cho mỗi lần Nâng 4K

        // 1. Kiểm tra số dư lượt của User trong Supabase
        const { data: user, error: userErr } = await supabase
            .from('users_tokens_render')
            .select('credits')
            .eq('email', email)
            .single();

        if (userErr || !user) {
            return res.status(404).json({ error: "Không tìm thấy tài khoản người dùng!" });
        }

        if (user.credits < COST_CREDITS) {
            return res.status(400).json({ 
                error: `Bạn cần tối thiểu ${COST_CREDITS} lượt để dùng tính năng Nâng 4K bằng Magnific AI! (Số dư hiện tại: ${user.credits})` 
            });
        }

        // 2. Lấy API Key Magnific / Freepik
        const apiKey = process.env.MAGNIFIC_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: "Server chưa cấu hình MAGNIFIC_API_KEY trong file .env!" });
        }

        // 3. Gọi API Magnific / Freepik Upscaler
        const response = await fetch("https://api.freepik.com/v1/ai/image-upscaler", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-freepik-api-key": apiKey
            },
            body: JSON.stringify({
                image: { image_url: imageUrl },
                scale_factor: 4,
                optimized_for: "architecture"
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("❌ Lỗi Magnific API:", data);
            return res.status(500).json({ error: data.message || "Lỗi xử lý phóng ảnh từ Magnific AI!" });
        }

        // Lấy URL ảnh 4K trả về từ Magnific
        const upscaledUrl = data.data?.[0]?.url || data.url || data.image;

        // 4. Trừ 100 lượt của User trong cơ sở dữ liệu
        const newCredits = user.credits - COST_CREDITS;
        await supabase
            .from('users_tokens_render')
            .update({ credits: newCredits })
            .eq('email', email);

        console.log(`✅ [NÂNG 4K SUCCESS] User: ${email} | Trừ 100 lượt | Còn lại: ${newCredits}`);

        // 5. Trả kết quả ảnh 4K về cho Plugin
        return res.json({
            success: true,
            upscaledUrl: upscaledUrl,
            remainingCredits: newCredits
        });

    } catch (err) {
        console.error("❌ Lỗi Server /api/upscale-4k:", err);
        return res.status(500).json({ error: "Lỗi hệ thống khi thực hiện Nâng 4K!" });
    }
});
// 🎯 API Trừ lượt real-time trên Supabase
app.post('/api/render/user/deduct', async (req, res) => {
  try {
    const { email, amount } = req.body;
    if (!email || !amount) return res.status(400).json({ error: 'Thiếu thông tin' });

    // 1. Lấy số dư hiện tại từ Supabase
    const { data: user, error: fetchErr } = await supabase
      .from('users_tokens_render')
      .select('credits')
      .eq('email', email)
      .single();

    if (fetchErr || !user) return res.status(404).json({ error: 'Không tìm thấy user' });

    // 2. Tính số dư mới (không âm)
    const newCredits = Math.max(0, user.credits - parseFloat(amount));

    // 3. Cập nhật lại vào Supabase
    const { data: updatedUser, error: updateErr } = await supabase
      .from('users_tokens_render')
      .update({ credits: newCredits })
      .eq('email', email)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    return res.json({ success: true, credits: updatedUser.credits });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});