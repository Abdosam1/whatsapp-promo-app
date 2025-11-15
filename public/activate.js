// هذه الدالة تعمل عندما يتم تحميل الصفحة بالكامل
document.addEventListener('DOMContentLoaded', () => {
    // 1. التحقق من وجود 'userInfo' التي تم تخزينها عند تسجيل الدخول
    const userInfo = localStorage.getItem('userInfo');

    // 2. إذا لم نجدها، فهذا يعني أن المستخدم غير مسجل الدخول
    if (!userInfo) {
        // يتم توجيهه فورًا إلى صفحة تسجيل الدخول
        window.location.href = '/login.html';
        return; // نتوقف هنا
    }

    // 3. إضافة وظيفة لزر تسجيل الخروج
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.onclick = () => {
            // حذف معلومات المستخدم من ذاكرة المتصفح
            localStorage.removeItem('userInfo');
            localStorage.removeItem('authToken'); // نحذف التوكن أيضًا للاحتياط
            window.location.href = '/login.html';
        };
    }
});

/**
 * هذه الدالة تعمل عندما يضغط المستخدم على أحد أزرار اختيار مدة الاشتراك
 * @param {string} period - اسم المدة (مثال: '6 months')
 * @param {number} days - عدد الأيام (مثال: 180)
 */
async function requestActivationCode(period, days) {
    const statusElement = document.getElementById('activation-status');
    // نعرض رسالة انتظار للمستخدم
    statusElement.textContent = 'المرجو الانتظار، يتم إرسال طلبك...';
    statusElement.style.color = '#333';

    // نستخرج معلومات المستخدم من الذاكرة التي خزناها أثناء تسجيل الدخول
    const userInfo = JSON.parse(localStorage.getItem('userInfo'));

    // نتأكد مرة أخرى من وجود معلومات المستخدم ومعرف المستخدم (ممارسة جيدة)
    if (!userInfo || !userInfo.userId) {
        statusElement.textContent = 'خطأ في تحديد هوية المستخدم. حاول تسجيل الدخول مرة أخرى.';
        statusElement.style.color = 'red';
        return;
    }

    try {
        // إرسال طلب إلى السيرفر لإنشاء الكود وإرساله لك عبر البريد الإلكتروني
        const response = await fetch('/request-activation-code', { // تأكد من أن هذا الرابط صحيح في السيرفر
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // نرسل التوكن في الهيدر لمزيد من الأمان إذا كان السيرفر يتطلبه
                'Authorization': `Bearer ${userInfo.token}` 
            },
            body: JSON.stringify({
                userId: userInfo.userId, // نرسل معرف المستخدم
                subscriptionPeriod: period,
                subscriptionDays: days
            }),
        });

        const data = await response.json();

        // إذا كان الطلب ناجحًا والسيرفر أكد ذلك
        if (response.ok && data.success) {
            
            // ======================================================
            // =========== هذا هو التغيير الذي طلبته ================
            // ======================================================
            // نوجه المستخدم مباشرة إلى صفحة إدخال الرمز
            window.location.href = '/email-confirmation.html';

        } else {
            // إذا أرجع السيرفر رسالة خطأ
            statusElement.textContent = data.message || 'حدث خطأ أثناء إرسال الطلب. حاول مرة أخرى.';
            statusElement.style.color = 'red';
        }

    } catch (error) {
        // إذا كان هناك خطأ في الشبكة أو الاتصال بالسيرفر
        console.error('Error requesting activation code:', error);
        statusElement.textContent = 'خطأ في الاتصال بالخادم. تحقق من اتصالك بالإنترنت.';
        statusElement.style.color = 'red';
    }
}
