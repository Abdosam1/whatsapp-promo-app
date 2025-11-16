// activate.js - النسخة النهائية والمحدثة

document.addEventListener('DOMContentLoaded', () => {
    // ===================================================================
    // 1. الكود الخاص بالتحقق من التوكن وزر الخروج (يبقى كما هو)
    // ===================================================================
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = 'index.html';
        return; // نوقف تنفيذ باقي الكود إذا لم يكن هناك توكن
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => { 
            localStorage.removeItem('authToken'); 
            alert('تم تسجيل الخروج'); 
            window.location.href = 'index.html'; 
        });
    }

    // ===================================================================
    // 2. الكود الجديد لربط الأزرار بروابط الدفع Gumroad
    // ===================================================================

    // المرجو تعديل هذه الروابط بروابط الدفع الخاصة بك من Gumroad
    const paymentLinks = {
        oneMonth: "https://gumroad.com/checkout?_gl=1*xda7wv*_ga*NjMwNDUxNzI0LjE3NjMzMDA5MTI.*_ga_6LJN6D94N6*czE3NjMzMDA5MTIkbzEkZzEkdDE3NjMzMDA5ODgkajYwJGwwJGgw",
        sixMonths: "الرابط-الخاص-بستة-أشهر-هنا", // <-- قم بتغيير هذا الرابط
        oneYear: "الرابط-الخاص-بسنة-واحدة-هنا"    // <-- قم بتغيير هذا الرابط
    };

    // نحدد الأزرار من الصفحة عن طريق الـ ID
    const btn1Month = document.getElementById('btn-1-month');
    const btn6Months = document.getElementById('btn-6-months');
    const btn1Year = document.getElementById('btn-1-year');

    // نضيف وظيفة النقر لكل زر ليوجه إلى صفحة الدفع
    if (btn1Month) {
        btn1Month.addEventListener('click', () => { window.location.href = paymentLinks.oneMonth; });
    }
    if (btn6Months) {
        btn6Months.addEventListener('click', () => { window.location.href = paymentLinks.sixMonths; });
    }
    if (btn1Year) {
        btn1Year.addEventListener('click', () => { window.location.href = paymentLinks.oneYear; });
    }

    // ===================================================================
    // 3. التحقق من حالة الاشتراك (يبقى كما هو)
    // ===================================================================
    checkSubscriptionStatus();
});


async function apiFetch(url, options = {}) {
    // ... (هذه الدالة تبقى كما هي، لا تغيير)
    const token = localStorage.getItem('authToken');
    const headers = { ...options.headers };
    if (token) { headers['Authorization'] = `Bearer ${token}`; }
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) { 
        localStorage.removeItem('authToken'); 
        alert("انتهت صلاحية الجلسة"); 
        window.location.href = 'index.html'; 
        throw new Error('Authentication failed'); 
    }
    if (!response.ok) { 
        const errorData = await response.json().catch(() => ({ message: `HTTP Error: ${response.statusText}` })); 
        throw new Error(errorData.message || 'حدث خطأ غير معروف'); 
    }
    const contentType = response.headers.get("content-type");
    return contentType && contentType.includes("application/json") ? response.json() : response.text();
}


async function checkSubscriptionStatus() {
    // ... (هذه الدالة تبقى كما هي، لا تغيير)
    try {
        const status = await apiFetch(`/api/check-status`);
        if (status.active) {
            window.location.href = 'dashboard.html'; 
        }
    } catch (error) {
        console.error("Failed to check status:", error.message);
    }
}


// ===================================================================
// ملاحظة هامة: الدالة التالية لم نعد نحتاجها هنا لأن الأزرار
// أصبحت توجه مباشرة إلى صفحة الدفع. لقد تم حذفها.
// async function requestActivationCode(...) { ... }
// ===================================================================
