// ================================================================= //
// ==================== activate.js - النسخة النهائية والمصححة =================== //
// ================================================================= //

// --- التحقق الأولي: هل المستخدم مسجل دخوله؟ ---
const token = localStorage.getItem('authToken');
if (!token) {
    // إذا لم يكن هناك توكن، يتم توجيه المستخدم فورًا إلى صفحة تسجيل الدخول
    window.location.href = 'index.html';
}

// --- عند اكتمال تحميل الصفحة ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. إعداد زر تسجيل الخروج
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => { 
            localStorage.removeItem('authToken'); 
            alert('تم تسجيل الخروج'); 
            window.location.href = 'index.html'; 
        });
    }

    // 2. التحقق من حالة الاشتراك (إذا كان المستخدم نشطًا بالفعل، يتم توجيهه للوحة التحكم)
    checkSubscriptionStatus();
});

// --- دالة مساعدة لإجراء طلبات API (هذه الدالة جيدة ولا تحتاج لتغيير) ---
async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('authToken');
    const headers = { ...options.headers };
    if (token) { headers['Authorization'] = `Bearer ${token}`; }
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }

    const response = await fetch(url, { ...options, headers });
    
    if (response.status === 401) { 
        localStorage.removeItem('authToken'); 
        alert("انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى."); 
        window.location.href = 'index.html'; 
        throw new Error('Authentication failed'); 
    }
    if (!response.ok) { 
        const errorData = await response.json().catch(() => ({ message: `خطأ من الخادم: ${response.statusText}` })); 
        throw new Error(errorData.message || 'حدث خطأ غير معروف'); 
    }
    
    const contentType = response.headers.get("content-type");
    return contentType && contentType.includes("application/json") ? response.json() : response.text();
}

// --- دالة للتحقق من حالة الاشتراك (جيدة ولا تحتاج لتغيير) ---
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


// ===================================================================================
// ===   الدالة الرئيسية التي تم تعديلها وتبسيطها لحل المشكلة   ===
// ===================================================================================
/**
 * ترسل طلب إنشاء الرمز، وعند النجاح، تقوم بتوجيه المستخدم إلى صفحة التأكيد.
 */
async function requestActivationCode(durationName, durationDays) {
    const statusEl = document.getElementById('activation-status');
    
    // 1. عرض رسالة انتظار للمستخدم
    statusEl.textContent = `...جاري طلب تفعيل اشتراك ${durationName}`;
    statusEl.style.color = 'orange';

    try {
        // 2. إرسال الطلب إلى السيرفر
        await apiFetch('/api/request-code', { 
            method: 'POST',
            body: JSON.stringify({ durationName, durationDays }) 
        });
        
        // 3. عند النجاح، تغيير الرسالة والاستعداد للتوجيه
        statusEl.textContent = '✅ تم استلام طلبك بنجاح! جاري توجيهك...';
        statusEl.style.color = 'var(--primary-color)';

        // 4. توجيه المستخدم مباشرة إلى صفحة إدخال الرمز
        // هذا هو السطر الذي سيتم تنفيذه الآن بعد نجاح الطلب
        window.location.href = '/email-confirmation.html';
        
    } catch (error) {
        // 5. في حالة الفشل، عرض رسالة الخطأ للمستخدم
        statusEl.textContent = `❌ فشل إرسال الطلب: ${error.message}`;
        statusEl.style.color = 'var(--danger-color)';
    }
}
// --- تم حذف دالة activateWithCode() لأنها غير ضرورية في هذه الصفحة ---
