import VerifyOtp from "@/components/Auth/VerifyOtp";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Vérification du code - Solid SaaS Boilerplate",
  description: "Vérifiez le code OTP reçu par email",
};

const VerifyOtpPage = () => {
  return (
    <>
      <VerifyOtp />
    </>
  );
};

export default VerifyOtpPage;
