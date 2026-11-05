/// <reference types="node" />
/**
 * Seed du premier compte Admin.
 *
 * Comme l'inscription publique est désactivée (seul un Admin peut créer
 * des comptes), ce script crée le compte Admin initial à partir de
 * variables d'environnement. Il ne fait rien si un Admin existe déjà.
 *
 * Usage:
 *   npx prisma db seed
 *   # ou directement :
 *   npx ts-node prisma/seed/seed-admin.ts
 *
 * Variables d'environnement (voir .env):
 *   SEED_ADMIN_EMAIL    (défaut: admin@analyzer.local)
 *   SEED_ADMIN_PASSWORD (défaut: ChangeMe123!)
 *   SEED_ADMIN_NAME     (défaut: Administrateur)
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@analyzer.local';
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const name = process.env.SEED_ADMIN_NAME || 'Administrateur';

  const existingAdmin = await prisma.user.findFirst({ where: { role: Role.ADMIN } });
  if (existingAdmin) {
    console.log(`ℹ️  Un Admin existe déjà (${existingAdmin.email}) — rien à faire.`);
    return;
  }

  const existingByEmail = await prisma.user.findUnique({ where: { email } });
  if (existingByEmail) {
    console.log(`⚠️  Un utilisateur avec l'email ${email} existe déjà mais n'est pas Admin.`);
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const admin = await prisma.user.create({
    data: {
      email,
      name,
      password: hashedPassword,
      role: Role.ADMIN,
      isEmailVerified: true, // le premier admin n'a pas besoin de vérifier son email
      isActive: true,
    },
  });

  console.log('✅ Compte Admin créé avec succès :');
  console.log(`   Email    : ${admin.email}`);
  console.log(`   Mot de passe : ${password}`);
  console.log('   ⚠️  Changez ce mot de passe dès la première connexion.');
}

main()
  .catch((err) => {
    console.error('❌ Erreur lors du seed :', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
