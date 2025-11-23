// activate.js - النسخة النهائية التي تجمع بين طلب الكود والتوجيه للدفع

// ===================================================================
//  1. إعدادات وروابط الدفع
//  (هذا هو المكان الوحيد الذي تحتاج لتعديله)
// ===================================================================

// المرجو تعديل هذه الروابط بروابط الدفع الخاصة بك من Gumroad
const paymentLinks = {
    oneMonth: "https://2802284640767.gumroad.com/l/gddbsb",
    sixMonths: "https://2802284640767.gumroad.com/l/wzyvba",
    oneYear: "https://2802284640767.gumroad.com/l/wkbctf",
};

// ===================================================================
//  2. الكود الرئيسي الذي يعمل عند تحميل الصفحة
// ===================================================================

// ننتظر حتى يتم تحميل جميع عناصر الصفحة قبل تنفيذ أي كود
document.addEventListener('DOMContentLoaded', () => {
    
    // التحقق من وجود توكن المصادقة. إذا لم يكن موجوداً، يتم إرجاع المستخدم لصفحة تسجيل الدخول
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = 'index.html';
        return; // نوقف تنفيذ باقي الكود
    }

    // إعداد وظيفة زر تسجيل الخروج
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => { 
            localStorage.removeItem('authToken'); 
            alert('تم تسجيل الخروج'); 
            window.location.href = 'index.html'; 
        });
    }

    // استدعاء الدالة التي تقوم بربط الأزرار بوظائفها
    setupSubscriptionButtons();

    // استدعاء الدالة التي تتحقق من حالة الاشتراك الحالية للمستخدم
    checkSubscriptionStatus();
});


// ===================================================================
//  3. الدوال الوظيفية
// ===================================================================

/**
 * دالة لربط كل زر اشتراك (شهر، 6 أشهر، سنة) بالوظيفة المناسبة له.
 * يتم فصل هذا الكود لزيادة التنظيم.
 */
function setupSubscriptionButtons() {
    const btn1Month = document.getElementById('btn-1-month');
    const btn6Months = document.getElementById('btn-6-months');
    const btn1Year = document.getElementById('btn-1-year');

    if (btn1Month) {
        btn1Month.addEventListener('click', () => 
            handleSubscriptionRequest('1 month', 30, paymentLinks.oneMonth)
        );
    }
    if (btn6Months) {
        btn6Months.addEventListener('click', () => 
            handleSubscriptionRequest('6 months', 180, paymentLinks.sixMonths)
        );
    }
    if (btn1Year) {
        btn1Year.addEventListener('click', () => 
            handleSubscriptionRequest('1 year', 365, paymentLinks.oneYear)
        );
    }
}

/**
 * دالة تعالج طلب الاشتراك: 
 * 1. ترسل الطلب للسيرفر لإنشاء الكود.
 * 2. بعد النجاح، توجه المستخدم لصفحة الدفع.
 */
async function handleSubscriptionRequest(durationName, durationDays, paymentLink) {
    const statusEl = document.getElementById('activation-status');
    statusEl.textContent = `...جاري تهيئة طلب اشتراك ${durationName}`;
    statusEl.style.color = 'orange';

    try {
        // الخطوة 1: نرسل طلب إنشاء الكود إلى السيرفر وننتظر الرد
        await apiFetch('/api/request-code', { 
            method: 'POST',
            body: JSON.stringify({ durationName, durationDays }) 
        });
        
        // عند نجاح الطلب، نعرض رسالة للمستخدم
        statusEl.textContent = '✅ تم إرسال الطلب بنجاح! جاري توجيهك للدفع...';
        statusEl.style.color = 'var(--primary-color)';

        // الخطوة 2: بعد نجاح الطلب، نوجه المستخدم لصفحة الدفع
        // نضع تأخير بسيط جداً (نصف ثانية) ليتمكن المستخدم من قراءة رسالة النجاح
        setTimeout(() => {
            window.location.href = paymentLink;
        }, 500);
        
    } catch (error) {
        // في حالة فشل طلب إنشاء الكود، نعرض رسالة الخطأ ولا نوجه المستخدم
        statusEl.textContent = `❌ فشل إرسال الطلب: ${error.message}`;
        statusEl.style.color = 'var(--danger-color)';
    }
}


/**
 * دالة لإرسال الطلبات إلى الـ API مع إضافة توكن المصادقة تلقائياً.
 * تعالج أيضاً الأخطاء الشائعة مثل انتهاء صلاحية الجلسة.
 */
async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('authToken');
    const headers = { ...options.headers };

    if (token) { 
        headers['Authorization'] = `Bearer ${token}`; 
    }

    // لتجنب المشاكل، يتم تحديد نوع المحتوى تلقائياً إلا إذا كان FormData
    if (!(options.body instanceof FormData)) { 
        headers['Content-Type'] = 'application/json'; 
    }

    const response = await fetch(url, { ...options, headers });

    // إذا كانت الجلسة منتهية (خطأ 401)، يتم تسجيل خروج المستخدم
    if (response.status === 401) { 
        localStorage.removeItem('authToken'); 
        alert("انتهت صلاحية الجلسة. المرجو تسجيل الدخول مرة أخرى."); 
        window.location.href = 'index.html'; 
        throw new Error('Authentication failed'); 
    }

    // إذا كان هناك خطأ آخر من السيرفر
    if (!response.ok) { 
        const errorData = await response.json().catch(() => ({ message: `HTTP Error: ${response.statusText}` })); 
        throw new Error(errorData.message || 'حدث خطأ غير معروف'); 
    }

    // يتم إرجاع الرد كـ JSON إذا كان ذلك ممكناً، أو كنص عادي
    const contentType = response.headers.get("content-type");
    return contentType && contentType.includes("application/json") ? response.json() : response.text();
}


/**
 * دالة للتحقق من حالة الاشتراك الحالية للمستخدم.
 * إذا كان المستخدم مشتركاً بالفعل، يتم توجيهه مباشرة إلى لوحة التحكم.
 */
async function checkSubscriptionStatus() {
    try {
        const status = await apiFetch(`/api/check-status`);
        if (status.active) {
            window.location.href = 'dashboard.html'; 
        }
    } catch (error) {
        // لا نعرض رسالة خطأ للمستخدم هنا، فقط نسجلها في الكونسول
        console.error("Failed to check subscription status:", error.message);
    }
}
