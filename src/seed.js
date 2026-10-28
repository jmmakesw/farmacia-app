'use strict';
// Dados iniciais: catálogo de EXEMPLO e conta do pessoal da farmácia.
const crypto = require('node:crypto');
const { db } = require('./db');
const { hashPassword } = require('./security');

// Nomes genéricos e preços inventados, apenas para demonstração.
// category, icon, name, pack, price (€), receita?, descrição
const SAMPLE = [
  ['Dor e febre', '💊', 'Paracetamol 500 mg', '20 comprimidos', 2.49, 0, 'Analgésico e antipirético para dores ligeiras a moderadas e febre.'],
  ['Dor e febre', '💊', 'Ibuprofeno 400 mg', '20 comprimidos', 4.19, 0, 'Anti-inflamatório e analgésico. Tomar com alimentos.'],
  ['Gripe e constipação', '🍯', 'Xarope para a tosse', '150 ml', 6.5, 0, 'Alivia a tosse e a irritação da garganta.'],
  ['Gripe e constipação', '💧', 'Soro fisiológico', '20 monodoses de 5 ml', 5.9, 0, 'Higiene nasal e ocular suave, para toda a família.'],
  ['Gripe e constipação', '🍬', 'Pastilhas para a garganta', '24 pastilhas', 5.2, 0, 'Alívio temporário da dor de garganta.'],
  ['Digestão', '💊', 'Antiácido mastigável', '24 comprimidos', 4.8, 0, 'Alívio rápido da azia e da acidez.'],
  ['Digestão', '🦠', 'Probiótico', '10 cápsulas', 12.9, 0, 'Suplemento para apoiar a flora intestinal.'],
  ['Primeiros socorros', '🩹', 'Pensos rápidos', '20 unidades', 2.9, 0, 'Pensos resistentes à água, tamanhos variados.'],
  ['Primeiros socorros', '🧴', 'Solução desinfetante', '100 ml', 4.3, 0, 'Desinfeção de pequenas feridas e escoriações.'],
  ['Primeiros socorros', '🌡️', 'Termómetro digital', '1 unidade', 7.9, 0, 'Leitura rápida, com sinal sonoro.'],
  ['Higiene e pele', '☀️', 'Protetor solar SPF 50', '50 ml', 14.9, 0, 'Proteção elevada para pele sensível.'],
  ['Higiene e pele', '🧴', 'Creme hidratante para mãos', '75 ml', 4.5, 0, 'Hidratação intensa para mãos secas.'],
  ['Vitaminas', '🍊', 'Vitamina C 1000 mg', '20 comprimidos efervescentes', 6.9, 0, 'Suplemento alimentar com vitamina C.'],
  ['Vitaminas', '🌿', 'Multivitamínico', '30 comprimidos', 11.5, 0, 'Suplemento diário de vitaminas e minerais.'],
  ['Bebé', '🍼', 'Pomada para assaduras', '100 g', 5.6, 0, 'Protege e acalma a pele do bebé.'],
  ['Antibióticos', '💊', 'Amoxicilina 500 mg', '16 cápsulas', 5.75, 1, 'Antibiótico. Requer receita médica.'],
  ['Cardiovascular', '💊', 'Atorvastatina 20 mg', '30 comprimidos', 7.4, 1, 'Para controlo do colesterol. Requer receita médica.'],
  ['Cardiovascular', '💊', 'Losartan 50 mg', '28 comprimidos', 6.2, 1, 'Para a tensão arterial. Requer receita médica.'],
  ['Diabetes', '💊', 'Metformina 850 mg', '60 comprimidos', 3.95, 1, 'Para a diabetes tipo 2. Requer receita médica.'],
  ['Estômago', '💊', 'Omeprazol 20 mg', '28 cápsulas', 5.1, 1, 'Reduz a produção de ácido gástrico. Requer receita médica.'],
];

function seedProducts() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM products').get();
  if (n > 0) return false;
  const insert = db.prepare(`INSERT INTO products
    (category, icon, name, pack, price_cents, requires_prescription, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const [category, icon, name, pack, price, rx, description] of SAMPLE) {
      insert.run(category, icon, name, pack, Math.round(price * 100), rx, description);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

async function ensureStaff() {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'staff' LIMIT 1").get();
  if (existing) return null;
  const email = (process.env.STAFF_EMAIL || 'farmacia@exemplo.pt').trim().toLowerCase();
  const generated = !process.env.STAFF_PASSWORD;
  const password = process.env.STAFF_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const hash = await hashPassword(password);
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'staff')")
    .run('Equipa da farmácia', email, hash);
  return { email, password: generated ? password : null };
}

module.exports = { seedProducts, ensureStaff };
