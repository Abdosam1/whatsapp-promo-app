document.addEventListener('DOMContentLoaded', () => {
    // --- أولاً وقبل كل شيء: اقرأ التوكن ---
    const token = localStorage.getItem('authToken');

    // إذا لم يكن هناك توكن، أعد التوجيه فورًا
    if (!token) {
        window.location.replace('/login.html');
        return;
    }

    // --- تحديد العناصر ---
    const subscriptionOptions = document.querySelectorAll('.subscription-option');
    const activationForm = document.getElementById('activation-form');
    const messageContainer = document.getElementById('message');

    // --- إضافة Event Listeners ---
    subscriptionOptions.forEach(button => {
        button.addEventListener('click', () => {
            const durationName = button.dataset.durationName;
            const durationDays = button.dataset.durationDays;
            requestActivationCode(durationName, durationDays);
        });
    });

    if (activationForm) {
        activationForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const activationCode = document.getElementById('activation-code').value;
            activateWithCode(activationCode);
        });
    }

    // --- دالة طلب كود التفعيل ---
    async function requestActivationCode(durationName, durationDays) {
        displayMessage('⏳ جاري إرسال طلب التفعيل...', 'info');
        try {
            const response = await fetch('/api/request-code', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}` // <-- استخدام التوكن الذي قرأناه في البداية
                },
                body: JSON.stringify({ durationName, durationDays })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'فشل إرسال الطلب');
            
            displayMessage('✅ تم إرسال طلبك. سيقوم المشرف بتزويدك برمز التفعيل.', 'success');

        } catch (error) {
            displayMessage(`❌ ${error.message}`, 'error');
        }
    }

    // --- دالة التفعيل بالكود ---
    async function activateWithCode(activationCode) {
        displayMessage('⏳ جاري التحقق من الرمز...', 'info');
        try {
            const response = await fetch('/api/activate-with-code', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}` // <-- استخدام التوكن هنا أيضًا
                },
                body: JSON.stringify({ activationCode })
            });
            
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'الرمز غير صالح');

            displayMessage('✅ تم تفعيل اشتراكك بنجاح! سيتم توجيهك الآن...', 'success');
            setTimeout(() => window.location.href = '/dashboard.html', 2000);

        } catch (error) {
            displayMessage(`❌ ${error.message}`, 'error');
        }
    }

    // --- دالة عرض الرسائل ---
    function displayMessage(message, type) {
        if (!messageContainer) return;
        messageContainer.textContent = message;
        messageContainer.className = `message ${type}`;
        messageContainer.style.display = message ? 'block' : 'none';
    }
});
