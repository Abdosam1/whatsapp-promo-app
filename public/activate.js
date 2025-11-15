// هذه الدالة تعمل عندما يتم تحميل الصفحة بالكامل
document.addEventListener('DOMContentLoaded', () => {
    // 1. التحقق من وجود توكن تسجيل الدخول 'authToken'
    const token = localStorage.getItem('authToken');

    // 2. إذا لم نجد التوكن، نوجه المستخدم إلى صفحة تسجيل الدخول
    if (!token) {
        window.location.href = '/login.html';
        return;
    }

    // 3. إضافة وظيفة لزر تسجيل الخروج
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.onclick = () => {
            localStorage.removeItem('authToken'); // نحذف التوكن فقط
            window.location.href = '/login.html';
        };
    }
});

/**
 * هذه الدالة تعمل عندما يضغط المستخدم على أحد أزرار اختيار مدة الاشتراك
 */
async function requestActivationCode(period, days) {
    const statusElement = document.getElementById('activation-status');
    statusElement.textContent = 'المرجو الانتظار، يتم إرسال طلبك...';
    statusElement.style.color = '#333';

    // نستخرج التوكن مباشرة من الذاكرة
    const token = localStorage.getItem('authToken');

    try {
        // إرسال طلب إلى السيرفر
        const response = await fetch('/request-activation-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // نرسل التوكن في الهيدر. هذه هي الطريقة الصحيحة للمصادقة
                'Authorization': `Bearer ${token}` 
            },
            // لم نعد نرسل userId هنا، لأن السيرفر سيستخرجه من التوكن
            body: JSON.stringify({
                subscriptionPeriod: period,
                subscriptionDays: days
            }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            // نوجه المستخدم مباشرة إلى صفحة إدخال الرمز
            window.location.href = '/email-confirmation.html';
        } else {
            statusElement.textContent = data.message || 'حدث خطأ أثناء إرسال الطلب. حاول مرة أخرى.';
            statusElement.style.color = 'red';
        }

    } catch (error) {
        console.error('Error requesting activation code:', error);
        statusElement.textContent = 'خطأ في الاتصال بالخادم. تحقق من اتصالك بالإنترنت.';
        statusElement.style.color = 'red';
    }
}
