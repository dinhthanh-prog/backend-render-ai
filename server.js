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

// 3. API ĐĂNG NHẬP GOOGLE CHO AI RENDER
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
            // 🎯 TRẢ VỀ THÊM CỘT ID
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

            // 🎯 TRẢ VỀ THÊM CỘT ID DÀNH CHO USER MỚI
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

// 5. WEBHOOK SEPAY THÔNG MINH (BẮT ĐÚNG TỪ KHÓA, HỖ TRỢ CẢ EMAIL THÔ LẪN ID SỐ)
app.post('/api/webhook/sepay-render', async (req, res) => {
    try {
        const { content, transferAmount, amount: rawAmount } = req.body;
        console.log("👉 [SEPAY WEBHOOK RECEIVED]:", req.body);

        if (!content) {
            return res.status(200).json({ success: true, message: "Nội dung trống" });
        }

        // 🎯 SỬA: cho phép bắt cả email thô (chứa @ và .), không chỉ chữ+số thuần.
        // Trước đây regex chỉ nhận [a-zA-Z0-9]+ nên cú pháp "AI dinhthanh@dt3dmodel.org"
        // bị cắt cụt tại dấu "@", chỉ bắt được "dinhthanh" và không khớp được với ai cả.
        const match = content.match(/\b(NAPRENDER|NAPTOKEN|AI)\s*([a-zA-Z0-9@._+-]+)/i);
        if (!match) {
            return res.status(200).json({ success: true, message: "Cú pháp không chứa tiền tố hợp lệ" });
        }

        // Lọc bỏ mọi ký tự đặc biệt (@, ., _, -, +) SAU KHI bắt được, để so khớp thống nhất
        // dù cú pháp là email thô ("dinhthanh@dt3dmodel.org") hay email đã làm sạch ("dinhthanhdt3dmodelorg") hay ID số ("11").
        const refCode = match[2].trim().toLowerCase().replace(/[^a-zA-Z0-9]/g, "");

        const amount = parseFloat(transferAmount || rawAmount || 0);
        const creditsToAdd = calculateCredits(amount);

        const { data: users, error: fetchErr } = await supabase
            .from('users_tokens_render')
            .select('*');

        if (fetchErr || !users) {
            console.error("Lỗi lấy danh sách user Supabase:", fetchErr);
            return res.status(500).json({ error: "Lỗi kết nối CSDL" });
        }

        const targetUser = users.find(u => {
            if (!u) return false;
            const isIdMatch = u.id && u.id.toString() === refCode;
            const userCleanEmail = u.email ? u.email.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : "";
            const isEmailMatch = userCleanEmail && userCleanEmail === refCode;
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

app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`✅ [SERVER RENDER AI] Đang chạy tại cổng ${PORT}`);
    console.log(`=============================================`);
});