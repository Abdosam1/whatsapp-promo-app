// ================================================================= //
// ==================== activate.js - منطق التفعيل =================== //
// ================================================================= //
// التحقق من التوكن (إجراء أمني أساسي)
const token = localStorage.getItem('authToken');
if (!token) {
    window.location.href = 'index.html'; // الرجوع لصفحة تسجيل الدخول إذا لم يكن هناك توكن
}

document.addEventListener('DOMContentLoaded', () => {
    // إعداد زر تسجيل الخروج
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => { 
            localStorage.removeItem('authToken'); 
            alert('تم تسجيل الخروج'); 
            window.location.href = 'index.html'; 
        });
    }

    // التحقق من حالة الاشتراك عند تحميل الصفحة
    checkSubscriptionStatus();
});

// دالة API Fetch (مكررة هنا لضمان عمل الصفحة باستقلالية)
async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('authToken');
    const headers = { ...options.headers };
    if (token) { headers['Authorization'] = `Bearer ${token}`; }
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }

    const response = await fetch(url, { ...options, headers });
    
    // إذا كان 401، التحويل لصفحة تسجيل الدخول
    if (response.status === 401) { 
        localStorage.removeItem('authToken'); 
        alert("انتهت صلاحية الجلسة"); 
        window.location.href = 'index.html'; 
        throw new Error('Authentication failed'); 
    }
    // ملاحظة: لا نحتاج لمعالجة 403 هنا لأننا أصلاً في صفحة التفعيل.
    if (!response.ok) { 
        const errorData = await response.json().catch(() => ({ message: `HTTP Error: ${response.statusText}` })); 
        throw new Error(errorData.message || 'حدث خطأ غير معروف'); 
    }
    
    const contentType = response.headers.get("content-type");
    return contentType && contentType.includes("application/json") ? response.json() : response.text();
}

// دالة التحقق من الاشتراك (للتحويل لـ Dashboard إذا كان التفعيل قد وقع في نافذة أخرى مثلاً)
async function checkSubscriptionStatus() {
    try {
        const status = await apiFetch(`/api/check-status?_=${new Date().getTime()}`);
        if (status.active) {
            // إذا كان الاشتراك مفعل، يحول مباشرة إلى الداشبورد
            window.location.href = 'dashboard.html'; 
        }
    } catch (error) {
        // إذا فشل الاتصال، يبقى المستخدم فصفحة التفعيل
        console.error("Failed to check status:", error.message);
    }
}


// --- 1. دالة طلب رمز التفعيل (إنشاء الرمز الأوتوماتيكي) ---
async function requestActivationCode(durationName, durationDays) {
    const optionsEl = document.getElementById('subscription-options');
    const statusEl = document.getElementById('activation-status');
    const formEl = document.getElementById('activation-form');
    const overlayMessage = document.getElementById('overlay-message');
    
    optionsEl.style.display = 'none';
    statusEl.textContent = `...جاري طلب تفعيل ${durationName} وإنشاء الرمز تلقائياً`;
    statusEl.style.color = 'orange';

    try {
        await apiFetch('/api/request-code', { 
            method: 'POST',
            body: JSON.stringify({ durationName, durationDays }) 
        });
        
        overlayMessage.innerHTML = `لقد اخترت اشتراك **${durationName}**.<br>لقد تم إنشاء الرمز تلقائياً وإرساله للمشرف. **المرجو إدخال الرمز بعد استلامه منه.**`;
        statusEl.textContent = '✅ تم إنشاء الرمز تلقائياً وإرسال طلب للمشرف بنجاح! يرجى إدخال الرمز بعد استلامه.';
        statusEl.style.color = 'var(--primary-color)';
        formEl.style.display = 'block'; 
        
    } catch (error) {
        statusEl.textContent = `❌ فشل إرسال الطلب: ${error.message || 'حدث خطأ.'}`;
        statusEl.style.color = 'var(--danger-color)';
        optionsEl.style.display = 'flex'; 
        formEl.style.display = 'none';
    }
}


// --- 2. دالة تفعيل الاشتراك بالرمز (التحويل المباشر لـ Dashboard) ---
async function activateWithCode() {
    const activateBtn = document.getElementById('activateBtn');
    const statusEl = document.getElementById('activation-status');
    const codeInput = document.getElementById('activationCodeInput');
    
    const activationCode = codeInput.value.trim();
    if (!activationCode) {
        statusEl.textContent = 'المرجو إدخال الرمز.';
        statusEl.style.color = 'var(--danger-color)';
        return;
    }

    activateBtn.disabled = true;
    statusEl.textContent = '...جاري التحقق من الرمز';
    statusEl.style.color = 'orange';

    try {
        await apiFetch('/api/activate-with-code', {
            method: 'POST',
            body: JSON.stringify({ activationCode: activationCode })
        });
        
        // التعديل المطلوب: التحويل المباشر لـ Dashboard مع Query Parameter
        statusEl.textContent = '✅ تم تفعيل اشتراكك بنجاح! جاري التحويل إلى لوحة التحكم...';
        statusEl.style.color = 'var(--primary-color)';

        setTimeout(() => {
            // إضافة ?activated=true لتخطي التحقق من Server في dashboard.js
            window.location.replace('dashboard.html?activated=true'); 
        }, 1000); // تقليل الوقت لـ 1 ثانية باش يكون التحويل أسرع

    } catch (error) {
        statusEl.textContent = `❌ ${error.message || 'رمز غير صالح أو حدث خطأ.'}`;
        statusEl.style.color = 'var(--danger-color)';
        activateBtn.disabled = false;
    }
}