// This function runs when the entire HTML page is loaded.
document.addEventListener('DOMContentLoaded', () => {
    // 1. Check if the login token exists.
    const token = localStorage.getItem('authToken');

    // If no token is found, redirect to the login page.
    if (!token) {
        window.location.href = '/login.html';
        return;
    }

    // 2. Add functionality to the logout button.
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.onclick = () => {
            // Remove the token and any other user data.
            localStorage.removeItem('authToken');
            // Redirect to the login page.
            window.location.href = '/login.html';
        };
    }
});

/**
 * A helper function to get the current user's data using the auth token.
 * This is more secure than storing user ID directly in localStorage.
 */
async function getCurrentUser() {
    const token = localStorage.getItem('authToken');
    if (!token) return null;

    try {
        // IMPORTANT: You need to create this endpoint on your server.
        // It should take the token, verify it, and return the user's data (like their ID).
        const response = await fetch('/api/auth/me', { // <-- Endpoint to get user data
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            // If the token is invalid or expired, log the user out.
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return null;
        }

        const userData = await response.json();
        return userData; // Should return something like { userId: '12345', name: '...' }

    } catch (error) {
        console.error("Error fetching user data:", error);
        return null;
    }
}


/**
 * Called when a user clicks on a subscription duration button.
 */
async function requestActivationCode(period, days) {
    const statusElement = document.getElementById('activation-status');
    statusElement.textContent = 'المرجو الانتظار، يتم الحصول على معلومات المستخدم...';
    statusElement.style.color = '#333';

    // Get user data from the server using the token.
    const user = await getCurrentUser();
    if (!user || !user.userId) {
        statusElement.textContent = 'خطأ: لا يمكن التحقق من هوية المستخدم. حاول تسجيل الدخول مرة أخرى.';
        statusElement.style.color = 'red';
        return;
    }

    statusElement.textContent = 'المرجو الانتظار، يتم إرسال طلبك...';

    try {
        const token = localStorage.getItem('authToken');
        // Send a request to your backend server.
        const response = await fetch('/request-activation-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` // Send token for authentication
            },
            body: JSON.stringify({
                userId: user.userId, // Send the user's ID we got from /api/auth/me
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
            statusElement.textContent = data.message || 'حدث خطأ أثناء إرسال الطلب.';
            statusElement.style.color = 'red';
        }
    } catch (error) {
        console.error('Error requesting activation code:', error);
        statusElement.textContent = 'خطأ في الاتصال بالخادم.';
        statusElement.style.color = 'red';
    }
}


/**
 * Called when the user enters the activation code and clicks the 'Activate' button.
 */
async function activateWithCode() {
    const codeInput = document.getElementById('activationCodeInput');
    const code = codeInput.value.trim();
    const statusElement = document.getElementById('activation-status');
    const token = localStorage.getItem('authToken');

    if (!code) {
        statusElement.textContent = 'المرجو إدخال رمز التفعيل.';
        statusElement.style.color = 'red';
        return;
    }
    
    statusElement.textContent = 'المرجو الانتظار، يتم التحقق من الرمز...';
    
    try {
        const response = await fetch('/verify-activation-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
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
        statusElement.textContent = 'خطأ في الاتصال بالخادم.';
        statusElement.style.color = 'red';
    }
}
