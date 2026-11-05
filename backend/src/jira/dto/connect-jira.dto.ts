import { IsEmail, IsNotEmpty, IsString, IsUrl } from 'class-validator';

export class ConnectJiraDto {
  @IsUrl({ require_tld: false }, { message: 'jiraBaseUrl doit être une URL valide (ex: https://monentreprise.atlassian.net)' })
  jiraBaseUrl: string;

  @IsEmail({}, { message: 'jiraEmail doit être un email valide (celui associé au compte Jira)' })
  jiraEmail: string;

  @IsString()
  @IsNotEmpty({ message: "apiToken est requis (jeton d'API Jira, pas le mot de passe)" })
  apiToken: string;
}
