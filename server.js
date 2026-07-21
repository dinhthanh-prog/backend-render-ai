require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 1. CẤU HÌNH SUPABASE
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.get('/', (req, res) => {
    res.send('✅ Server Render AI (Supabase + SePay) đang chạy!');
});

// 2. QUY ĐỔI TIỀN SANG LƯỢT RENDER
function calculateCredits(amount) {
    if (amount >= 500000) return 625;
    if (amount >= 200000) return 235;
    if (amount >= 100000) return 110;
    if (amount >= 50000) return 50;
    return Math.floor(amount / 1000);
}

// 3. API ĐĂNG NHẬP GOOGLE (CÓ TRẢ VỀ ID ĐỂ GHÉP MÃ QR)
app.post('/api/render/auth/google', async (req, res) => {
    try {
        const { email } = req.body;
        console.log(`📩 [Auth Render] Yêu cầu đăng nhập: ${email}`);
        if (!email) return res.status(400).json({ error: "Thiếu Email" });

        const { data: userWallet, error: selectErr } = await supabase
            .from('users_tokens_render')
            .select('*')
            .eq('email', email)
            .maybeSingle();

        if (selectErr) console.error("❌ Lỗi Supabase Select:", selectErr.message);

        if (userWallet) {
            console.log(`✅ User cũ: ${email} - ID: ${userWallet.id} - Số dư: ${userWallet.credits} Lượt`);
            return res.json({ id: userWallet.id, email: userWallet.email, credits: userWallet.credits });
        } else {
            console.log(`✨ Tạo user mới: ${email} - Khởi tạo 0 Lượt`);
            const { data: newUser, error: insertErr } = await supabase
                .from('users_tokens_render')
                .insert([{ email: email, credits: 0 }])
                .select()
                .single();

            if (insertErr) {
                console.error("❌ Lỗi Insert Supabase:", insertErr.message);
                return res.status(500).json({ error: insertErr.message });
            }

            return res.json({ id: newUser.id, email: newUser.email, credits: 0 });
        }
    } catch (err) {
        console.error("❌ Lỗi Auth:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

// 4. API KIỂM TRA SỐ DƯ RENDER
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

// 5. WEBHOOK SEPAY THÔNG MINH (BÓC TÁCH CHÍNH XÁC ID + EMAIL)
app.post('/api/webhook/sepay-render', async (req, res) => {
    try {
        const { content, transferAmount, amount: rawAmount } = req.body;
        console.log("👉 [SEPAY WEBHOOK RECEIVED]:", req.body);

        if (!content) {
            return res.status(200).json({ success: true, message: "Nội dung trống" });
        }

        // Bắt các từ khóa tiền tố: AI, NAPRENDER, NAPTOKEN
        const match = content.match(/\b(AI|NAPRENDER|NAPTOKEN)\s+([a-zA-Z0-9\s]+)/i);
        if (!match) {
            return res.status(200).json({ success: true, message: "Không chứa cú pháp hợp lệ" });
        }

        // Tách các từ đằng sau tiền tố
        const payloadText = match[2].trim();
        const parts = payloadText.split(/\s+/);
        
        const maybeId = parts[0]; 
        const maybeEmail = parts[1] || parts[0];

        const amount = parseFloat(transferAmount || rawAmount || 0);
        const creditsToAdd = calculateCredits(amount);

        const { data: users, error: fetchErr } = await supabase
            .from('users_tokens_render')
            .select('*');

        if (fetchErr || !users) {
            console.error("Lỗi lấy danh sách user Supabase:", fetchErr);
            return res.status(500).json({ error: "Lỗi kết nối CSDL" });
        }

        // Ưu tiên khớp ID trước, nếu không thì khớp Email
        const targetUser = users.find(u => {
            if (!u) return false;
            const isIdMatch = u.id && u.id.toString() === maybeId;
            const userCleanEmail = u.email ? u.email.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : "";
            const isEmailMatch = userCleanEmail && (userCleanEmail === maybeEmail.toLowerCase() || userCleanEmail === maybeId.toLowerCase());
            return isIdMatch || isEmailMatch;
        });

        if (!targetUser) {
            console.log(`❌ Không tìm thấy user với thông tin: ID=${maybeId}, Email=${maybeEmail}`);
            return res.status(200).json({ success: false, message: "Không tìm thấy User" });
        }

        const currentCredits = parseFloat(targetUser.credits) || 0;
        const newCredits = currentCredits + creditsToAdd;

        const { error: updateErr } = await supabase
            .from('users_tokens_render')
            .update({ credits: newCredits })
            .eq('id', targetUser.id);

        if (updateErr) {
            console.error("Lỗi cập nhật số dư:", updateErr);
            return res.status(500).json({ error: "Lỗi cập nhật số dư" });
        }

        console.log(`🎉 [SEPAY SUCCESS] Đã cộng ${creditsToAdd} Lượt cho User ID ${targetUser.id} (${targetUser.email}). Số dư mới: ${newCredits}`);
        return res.status(200).json({ success: true, message: "Cộng lượt thành công" });

    } catch (err) {
        console.error("Lỗi xử lý Webhook SePay:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 6. KHỞI ĐỘNG SERVER
app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`✅ [SERVER RENDER AI] Đang chạy tại cổng ${PORT}`);
    console.log(`=============================================`);
});