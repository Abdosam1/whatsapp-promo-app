document.addEventListener('DOMContentLoaded', () => {
    const userInfo = localStorage.getItem('userInfo');
    if (!userInfo) {
        window.location.href = '/login.html';
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.onclick = () => {
            localStorage.removeItem('userInfo');

            window.location.href = '/login.html';
        };
    }
});

async function requestActivationCode(period, days) {
    const statusElement = document.getElementById('activation-status');
    statusElement.textContent = 'المرجو الانتظار، يتم إرسال طلبك...';
    statusElement.style.color = '#333';

    const userInfo = JSON.parse(localStorage.getItem('userInfo'));
    if (!userInfo || !userInfo.userId) {
        statusElement.textContent = 'خطأ: لم يتم العثور على معلومات المستخدم. يرجى تسجيل الدخول مرة أخرى.';
        statusElement.style.color = 'red';
        return;
    }

    try {
        const response = await fetch('/request-activation-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userId: userInfo.userId,
                subscriptionPeriod: period,
                subscriptionDays: days
            }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            statusElement.textContent = 'تم إرسال طلبك بنجاح! سيتم التواصل معك من طرف المشرف لتزويدك بالرمز.';
            statusElement.style.color = 'green';
            
            document.getElementById('subscription-options').style.display = 'none';
            document.getElementById('overlay-message').style.display = 'none';
            document.getElementById('activation-form').style.display = 'block';

        } else {
            statusElement.textContent = data.message || 'حدث خطأ أثناء إرسال الطلب. المرجو المحاولة لاحقاً.';
            statusElement.style.color = 'red';
        }
    } catch (error) {
        console.error('Error requesting activation code:', error);
        statusElement.textContent = 'خطأ في الاتصال بالخادم. تحقق من اتصالك بالإنترنت.';
        statusElement.style.color = 'red';
    }
}

async function activateWithCode() {
    const codeInput = document.getElementById('activationCodeInput');
    const code = codeInput.value.trim();
    const statusElement = document.getElementById('activation-status');
    const userInfo = JSON.parse(localStorage.getItem('userInfo'));

    if (!code) {
        statusElement.textContent = 'المرجو إدخال رمز التفعيل.';
        statusElement.style.color = 'red';
        return;
    }

    statusElement.textContent = 'المرجو الانتظار، يتم التحقق من الرمز...';
    statusElement.style.color = '#333';

    try {
        const response = await fetch('/verify-activation-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userId: userInfo.userId,
                activationCode: code
            }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            statusElement.textContent = 'تم تفعيل اشتراكك بنجاح! يتم الآن إعادة توجيهك.';
            statusElement.style.color = 'green';

            setTimeout(() => {
                window.location.href = '/dashboard.html';
            }, 2000);

        } else {
            statusElement.textContent = data.message || 'الرمز الذي أدخلته غير صحيح أو منتهي الصلاحية.';
            statusElement.style.color = 'red';
        }
    } catch (error) {
        console.error('Error verifying activation code:', error);
        statusElement.textContent = 'خطأ في الاتصال بالخادم. تحقق من اتصالك بالإنترنت.';
        statusElement.style.color = 'red';
    }
}
