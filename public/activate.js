// activate.js - النسخة النهائية التي تجمع بين طلب الكود والتوجيه لصفحة الدفع

document.addEventListener('DOMContentLoaded', () => {
    // 1. الكود الخاص بالتحقق من التوكن وزر الخروج (يبقى كما هو)
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => { 
            localStorage.removeItem('authToken'); 
            alert('تم تسجيل الخروج'); 
            window.location.href = 'index.html'; 
        });
    }

    // 2. التحقق من حالة الاشتراك (يبقى كما هو)
    checkSubscriptionStatus();
});


// 3. دالة الاتصال بالـ API (تبقى كما هي)
async function apiFetch(url, options = {}) {
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


// 4. دالة التحقق من حالة الاشتراك (تبقى كما هي)
async function checkSubscriptionStatus() {
    try {
        const status = await apiFetch(`/api/check-status`);
        if (status.active) {
            window.location.href = 'dashboard.html'; 
        }
    } catch (error) {
        console.error("Failed to check status:", error.message);
    }
}


// 5. تعديل دالة requestActivationCode لتشمل التوجيه بعد النجاح
// هذه هي الدالة التي سيتم استدعاؤها من HTML
async function handleSubscriptionRequest(durationName, durationDays, paymentLink) {
    const statusEl = document.getElementById('activation-status');
    statusEl.textContent = `...جاري تهيئة طلب اشتراك ${durationName}`;
    statusEl.style.color = 'orange';

    try {
        // الخطوة 1: نرسل طلب إنشاء الكود إلى السيرفر
        await apiFetch('/api/request-code', { 
            method: 'POST',
            body: JSON.stringify({ durationName, durationDays }) 
        });
        
        statusEl.textContent = '✅ تم إرسال الطلب بنجاح! جاري توجيهك للدفع...';
        statusEl.style.color = 'var(--primary-color)';

        // الخطوة 2: بعد نجاح الطلب، نوجه المستخدم لصفحة الدفع
        window.location.href = paymentLink;
        
    } catch (error) {
        // في حالة فشل طلب إنشاء الكود، نعرض الخطأ ولا نوجه المستخدم
        statusEl.textContent = `❌ فشل إرسال الطلب: ${error.message}`;
        statusEl.style.color = 'var(--danger-color)';
    }
}
