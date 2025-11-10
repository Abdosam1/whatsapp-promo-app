const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

router.delete('/deletePromo/:id', (req, res) => {
  const promoId = parseInt(req.params.id);
  const promosPath = path.join(__dirname, 'promos.json');

  if (!fs.existsSync(promosPath)) {
    return res.status(404).json({ status: 'error', message: 'ملف العروض غير موجود' });
  }

  let promos = JSON.parse(fs.readFileSync(promosPath, 'utf8'));
  const index = promos.findIndex(p => p.id === promoId);

  if (index === -1) {
    return res.status(404).json({ status: 'error', message: 'العرض غير موجود' });
  }

  // حذف صورة العرض من المجلد
  const imagePath = path.join(__dirname, 'public', 'promos', promos[index].image);
  if (fs.existsSync(imagePath)) {
    fs.unlinkSync(imagePath);
  }

  // حذف العرض من القائمة
  promos.splice(index, 1);

  // حفظ التغييرات
  fs.writeFileSync(promosPath, JSON.stringify(promos, null, 2));

  res.json({ status: 'deleted' });
});

module.exports = router;