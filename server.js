// استبدل الحدث القديم بهذا
socket.on('send-promo', async (data) => {
    const { phone, promoId, fromImported } = data;
    if (!activeUserId || !whatsappClients[activeUserId]) return;
    
    const currentClient = whatsappClients[activeUserId];
    const promos = readPromos(activeUserId);
    const promo = promos.find(p => p.id === promoId);

    if (!promo) {
        return socket.emit('send-promo-status', { success: false, phone, error: 'العرض غير موجود' });
    }

    try {
        const numberId = `${phone.replace(/\D/g, "")}@c.us`;

        // --- المنطق الجديد للتعامل مع جميع الحالات ---

        // الحالة 1: إذا كان هناك صورة (سواء معها نص أو لا)
        if (promo.image) {
            const media = MessageMedia.fromFilePath(path.join(promosUploadFolder, promo.image));
            // نرسل الصورة مع النص كـ caption (إذا كان النص موجوداً)
            await currentClient.sendMessage(numberId, media, { caption: promo.text });
        } 
        // الحالة 2: إذا لم تكن هناك صورة، ولكن هناك نص
        else if (promo.text) {
            // نرسل النص فقط، مع تفعيل خاصية معاينة الروابط
            await currentClient.sendMessage(numberId, promo.text, { linkPreview: true });
        }
        // إذا لم يكن هناك لا صورة ولا نص (حالة نادرة)، لا نرسل شيئًا

        const table = fromImported ? "imported_clients" : "clients";
        db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone, activeUserId]);
        socket.emit('send-promo-status', { success: true, phone });
    } catch (err) {
        socket.emit('send-promo-status', { success: false, phone, error: err.message });
    }
});
