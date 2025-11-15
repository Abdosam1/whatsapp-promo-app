// validation.js - الكود الخاص بصفحة التحقق من الرمز

async function verifyActivationCode() {
    const codeInput = document.getElementById('activationCodeInput');
    const statusMsg = document.getElementById('status-message');
    const verifyBtn = document.getElementById('verifyBtn');
    const activationCode = codeInput.value.trim();

    if (!activationCode) {
        statusMsg.textContent = 'المرجو إدخال الرمز.';
        statusMsg.style.color = 'red';
        return;
    }

    statusMsg.textContent = 'جاري التحقق من الرمز...';
    statusMsg.style.color = '#333';
    verifyBtn.disabled = true;

    try {
        const token = localStorage.getItem('authToken');
        if (!token) {
            throw new Error("لم يتم العثور على معلومات المستخدم. حاول تسجيل الدخول مرة أخرى.");
        }

        const response = await fetch('/api/activate-with-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ activationCode })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || 'حدث خطأ غير متوقع');
        }

        statusMsg.textContent = 'تم تفعيل الحساب بنجاح! جاري توجيهك...';
        statusMsg.style.color = 'green';
        
        setTimeout(() => {
            window.location.href = '/dashboard.html';
        }, 2000);

    } catch (error) {
        statusMsg.textContent = error.message;
        statusMsg.style.color = 'red';
        verifyBtn.disabled = false;
    }
}
