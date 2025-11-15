// activate.js - النسخة النهائية والمحدثة

document.addEventListener('DOMContentLoaded', () => {
    // ... (الكود الخاص بالتحقق من التوكن وزر الخروج يبقى كما هو)
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = 'index.html';
    }
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => { 
            localStorage.removeItem('authToken'); 
            alert('تم تسجيل الخروج'); 
            window.location.href = 'index.html'; 
        });
    }
    checkSubscriptionStatus();
});

async function apiFetch(url, options = {}) {
    // ... (هذه الدالة تبقى كما هي)
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
    // ... (هذه الدالة تبقى كما هي)
    try {
        const status = await apiFetch(`/api/check-status`);
        if (status.active) {
            window.location.href = 'dashboard.html'; 
        }
    } catch (error) {
        console.error("Failed to check status:", error.message);
    }
}

async function requestActivationCode(durationName, durationDays) {
    const statusEl = document.getElementById('activation-status');
    statusEl.textContent = `...جاري طلب تفعيل اشتراك ${durationName}`;
    statusEl.style.color = 'orange';

    try {
        await apiFetch('/api/request-code', { 
            method: 'POST',
            body: JSON.stringify({ durationName, durationDays }) 
        });
        
        statusEl.textContent = '✅ تم استلام طلبك بنجاح! جاري توجيهك...';
        statusEl.style.color = 'var(--primary-color)';

        // ======================================================
        // =========== هنا تم التغيير حسب طلبك ==================
        // ======================================================
        window.location.href = '/validation.html'; // تم تغيير الاسم هنا
        
    } catch (error) {
        statusEl.textContent = `❌ فشل إرسال الطلب: ${error.message}`;
        statusEl.style.color = 'var(--danger-color)';
    }
}
