import ResetPassword from "@/components/Auth/ResetPassword";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Nouveau mot de passe - Solid SaaS Boilerplate",
  description: "Réinitialiser votre mot de passe",
};

const ResetPasswordPage = () => {
  return (
    <>
      <ResetPassword />
    </>
  );
};

export default ResetPasswordPage;
