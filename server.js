// Fix Webhook SePay V2            
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

// Route kiểm tra nhanh server có sống không (mở link này trên trình duyệt để xác nhận deploy thành công)
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

// 3. API ĐĂNG NHẬP GOOGLE CHO AI RENDER (GÁN MẶC ĐỊNH 0 LƯỢT)
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
            console.log(`✅ User cũ: ${email} - Số dư: ${userWallet.credits} Lượt`);
            return res.json({ email: userWallet.email, credits: userWallet.credits });
        } else {
            // 🎯 TẠO USER MỚI VỚI 0 LƯỢT MẶC ĐỊNH
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

            return res.json({ email: newUser.email, credits: 0 });
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

// =========================================================
// 💳 WEBHOOK SEPAY TỰ ĐỘNG CỘNG LƯỢT (CÚ PHÁP MỚI: AI + EMAIL)
// =========================================================
app.post('/api/webhook/sepay-render', async (req, res) => {
    try {
        const { content, transferAmount, amount: rawAmount } = req.body;
        console.log("👉 [SEPAY WEBHOOK RECEIVED]:", req.body);

        // 🎯 LỌC CÚ PHÁP CÓ CHỨA TỪ KHÓA "AI"
        if (!content || !content.toUpperCase().includes('AI')) {
            return res.status(200).json({ success: true, message: "Giao dịch không có từ khóa AI" });
        }

        // Tách lấy mã đằng sau từ khóa AI (Ví dụ: "AI vanthanh030291gmailcom")
        const match = content.match(/AI\s*([a-zA-Z0-9]+)/i);
        if (!match) {
            return res.status(200).json({ success: true, message: "Cú pháp chuyển khoản không hợp lệ" });
        }

        const refCode = match[1].trim().toLowerCase();
        const amount = parseFloat(transferAmount || rawAmount || 0);
        const creditsToAdd = calculateCredits(amount);

        const { data: users, error: fetchErr } = await supabase
            .from('users_tokens_render')
            .select('*');

        if (fetchErr || !users) {
            console.error("Lỗi lấy danh sách user Supabase:", fetchErr);
            return res.status(500).json({ error: "Lỗi kết nối CSDL" });
        }

        // Tìm user khớp theo ID hoặc Clean Email
        const targetUser = users.find(u => {
            if (!u || !u.email) return false;
            const isIdMatch = u.id.toString() === refCode;
            const userCleanEmail = u.email.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
            const isEmailMatch = userCleanEmail === refCode;
            return isIdMatch || isEmailMatch;
        });

        if (!targetUser) {
            console.log(`❌ Không tìm thấy user khớp với mã ref: ${refCode}`);
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