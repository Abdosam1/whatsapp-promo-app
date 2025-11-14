// This function runs when the entire HTML page is loaded and ready.
document.addEventListener('DOMContentLoaded', () => {
    // 1. Check if the user is logged in
    // It looks for 'userInfo' in the browser's local storage.
    const userInfo = localStorage.getItem('userInfo');

    // If 'userInfo' is not found, it means the user is not logged in.
    if (!userInfo) {
        // Redirect the user to the login page immediately.
        // Make sure your login page is named 'login.html' or change the path here.
        window.location.href = '/login.html';
        return; // Stop running the rest of the script
    }

    // 2. Add functionality to the logout button
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        // When the logout button is clicked...
        logoutBtn.onclick = () => {
            // Remove the user's information from local storage.
            localStorage.removeItem('userInfo');
            // Redirect the user to the login page.
            window.location.href = '/login.html';
        };
    }
});

/**
 * This function is called when a user clicks on a subscription duration button.
 * e.g., onclick="requestActivationCode('6 months', 180)"
 * @param {string} period - The name of the subscription period (e.g., '6 months').
 * @param {number} days - The number of days for the subscription.
 */
async function requestActivationCode(period, days) {
    const statusElement = document.getElementById('activation-status');
    statusElement.textContent = 'المرجو الانتظار، يتم إرسال طلبك...';
    statusElement.style.color = '#333';

    // Get user info from local storage to send their ID to the server.
    const userInfo = JSON.parse(localStorage.getItem('userInfo'));

    // Double-check if user info exists (it should, but it's good practice).
    if (!userInfo || !userInfo.userId) {
        statusElement.textContent = 'خطأ: لم يتم العثور على معلومات المستخدم. يرجى تسجيل الدخول مرة أخرى.';
        statusElement.style.color = 'red';
        return;
    }

    try {
        // Send a request to your backend server.
        // IMPORTANT: Your server must have an endpoint at '/request-activation-code'.
        const response = await fetch('/request-activation-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userId: userInfo.userId, // Send the user's ID
                subscriptionPeriod: period, // Send the chosen period
                subscriptionDays: days // Send the chosen duration in days
            }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            // If the server responds successfully
            statusElement.textContent = 'تم إرسال طلبك بنجاح! سيتم التواصل معك من طرف المشرف لتزويدك بالرمز.';
            statusElement.style.color = 'green';
            
            // Hide the subscription choice buttons
            document.getElementById('subscription-options').style.display = 'none';
            document.getElementById('overlay-message').style.display = 'none';
            // Show the form to enter the activation code
            document.getElementById('activation-form').style.display = 'block';

        } else {
            // If the server responds with an error
            statusElement.textContent = data.message || 'حدث خطأ أثناء إرسال الطلب. المرجو المحاولة لاحقاً.';
            statusElement.style.color = 'red';
        }
    } catch (error) {
        // If there's a network error (e.g., server is down)
        console.error('Error requesting activation code:', error);
        statusElement.textContent = 'خطأ في الاتصال بالخادم. تحقق من اتصالك بالإنترنت.';
        statusElement.style.color = 'red';
    }
}

/**
 * This function is called when the user enters the activation code and clicks the 'Activate' button.
 */
async function activateWithCode() {
    const codeInput = document.getElementById('activationCodeInput');
    const code = codeInput.value.trim();
    const statusElement = document.getElementById('activation-status');
    const userInfo = JSON.parse(localStorage.getItem('userInfo'));

    // Check if the input is empty
    if (!code) {
        statusElement.textContent = 'المرجو إدخال رمز التفعيل.';
        statusElement.style.color = 'red';
        return;
    }

    statusElement.textContent = 'المرجو الانتظار، يتم التحقق من الرمز...';
    statusElement.style.color = '#333';

    try {
        // Send the code to the backend for verification.
        // IMPORTANT: Your server must have an endpoint at '/verify-activation-code'.
        const response = await fetch('/verify-activation-code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userId: userInfo.userId, // Send the user's ID
                activationCode: code // Send the code they entered
            }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            // If the code is correct
            statusElement.textContent = 'تم تفعيل اشتراكك بنجاح! يتم الآن إعادة توجيهك.';
            statusElement.style.color = 'green';

            // Wait 2 seconds, then redirect to the main dashboard.
            // Make sure your dashboard page is named 'dashboard.html' or change the path here.
            setTimeout(() => {
                window.location.href = '/dashboard.html';
            }, 2000);

        } else {
            // If the code is incorrect or expired
            statusElement.textContent = data.message || 'الرمز الذي أدخلته غير صحيح أو منتهي الصلاحية.';
            statusElement.style.color = 'red';
        }
    } catch (error) {
        // If there's a network error
        console.error('Error verifying activation code:', error);
        statusElement.textContent = 'خطأ في الاتصال بالخادم. تحقق من اتصالك بالإنترنت.';
        statusElement.style.color = 'red';
    }
}
