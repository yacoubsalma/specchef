import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly fromAddress: string;
  private readonly frontendUrl: string;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('EMAIL_HOST');
    const port = this.configService.get<number>('EMAIL_PORT');
    const user = this.configService.get<string>('EMAIL_USER');
    const pass = this.configService.get<string>('EMAIL_PASSWORD');
    // L'adresse réelle est toujours techniquement présente dans le header From,
    // mais le nom d'affichage "Analyzer" est ce que la majorité des clients mail
    // (Gmail, Outlook...) montrent en priorité dans la boîte de réception.
    this.fromAddress = this.configService.get<string>('EMAIL_FROM') || 'no-reply@analyzer.local';
    // URL du frontend Next.js, utilisée pour générer un lien direct dans les
    // emails (activation de compte / réinitialisation de mot de passe).
    this.frontendUrl = (
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3004'
    ).replace(/\/+$/, '');

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port: port ? Number(port) : 587,
        secure: Number(port) === 465,
        auth: { user, pass },
      });
    } else {
      this.logger.warn(
        '⚠️  Configuration email absente (EMAIL_HOST/EMAIL_USER/EMAIL_PASSWORD) — ' +
          'les emails seront uniquement loggés dans la console (mode dev).',
      );
    }
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`📧 [DEV — email simulé] À: ${to} | Sujet: ${subject}`);
      this.logger.log(html.replace(/<[^>]+>/g, ' ').trim());
      return;
    }

    try {
      await this.transporter.sendMail({
        // Nom + adresse affichés au destinataire. Avec un SMTP Gmail standard,
        // le compte authentifié (EMAIL_USER) reste présent dans les en-têtes
        // techniques du message, mais "Analyzer <no-reply@...>" est ce qui
        // s'affiche dans la boîte de réception (Gmail, Outlook, etc.).
        from: `"Analyzer" <${this.fromAddress}>`,
        to,
        subject,
        html,
      });
    } catch (err: any) {
      this.logger.error(`❌ Échec envoi email à ${to}: ${err.message}`);
      throw err;
    }
  }

  async sendOtpEmail(
    to: string,
    otp: string,
    purpose: 'verify' | 'reset' | 'change-password',
  ): Promise<void> {
    const subject =
      purpose === 'verify'
        ? 'Vérifiez votre compte Analyzer'
        : purpose === 'change-password'
        ? 'Code de confirmation — changement de mot de passe Analyzer'
        : 'Réinitialisation de votre mot de passe Analyzer';

    const intro =
      purpose === 'verify'
        ? 'Votre compte a été créé. Cliquez sur le bouton ci-dessous (ou utilisez le code) pour vérifier votre adresse email :'
        : purpose === 'change-password'
        ? 'Vous avez demandé à changer votre mot de passe depuis votre page de compte. Utilisez ce code pour confirmer le changement :'
        : 'Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous (ou utilisez le code) :';

    // Pas de bouton/lien pour change-password : la confirmation se fait
    // directement sur la page /account déjà ouverte par l'utilisateur.
    const showButton = purpose !== 'change-password';
    const verifyUrl = `${this.frontendUrl}/auth/verify-otp?type=${purpose}&email=${encodeURIComponent(to)}&otp=${encodeURIComponent(otp)}`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Analyzer</h2>
        <p>${intro}</p>
        ${
          showButton
            ? `<p style="text-align: center; margin: 24px 0;">
          <a href="${verifyUrl}" style="display: inline-block; background: #4A6CF7; color: #ffffff; text-decoration: none; font-weight: bold; padding: 12px 28px; border-radius: 999px;">
            ${purpose === 'verify' ? 'Activer mon compte' : 'Réinitialiser mon mot de passe'}
          </a>
        </p>`
            : ''
        }
        <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; text-align: center;">${otp}</p>
        <p style="color: #64748b; font-size: 13px;">${
          purpose === 'change-password'
            ? 'Si vous n\'êtes pas à l\'origine de cette demande, changez votre mot de passe immédiatement.'
            : 'Si le bouton ne fonctionne pas, utilisez ce code directement sur la page de vérification.'
        } Ce code expire dans 15 minutes.</p>
      </div>
    `;

    await this.send(to, subject, html);
  }

  async sendAccountCreatedEmail(
    to: string,
    name: string,
    tempPassword: string,
    role: string,
  ): Promise<void> {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Bienvenue sur Analyzer, ${name}</h2>
        <p>Un administrateur a créé un compte pour vous avec le rôle <b>${role}</b>.</p>
        <p>Identifiants temporaires :</p>
        <ul>
          <li>Email : ${to}</li>
          <li>Mot de passe temporaire : <b>${tempPassword}</b></li>
        </ul>
        <p>Un code de vérification a été envoyé séparément pour activer votre compte.
        Nous vous recommandons de changer ce mot de passe dès votre première connexion.</p>
      </div>
    `;

    await this.send(to, 'Votre compte Analyzer a été créé', html);
  }
}