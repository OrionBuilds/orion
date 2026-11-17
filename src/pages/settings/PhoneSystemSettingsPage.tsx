import { TwilioConfig } from '../../components/settings/TwilioConfig';

/**
 * Phone System settings — unified TwilioConfig panel that handles connection
 * status, number assignment (SMS → Clara/user; voice is answered by Clara),
 * and webhook URLs. Credentials live in platform-wide env vars.
 */
export default function PhoneSystemSettingsPage() {
  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold text-white">Phone System</h1>
        <p className="text-sm text-hud-cream-dim mt-1">
          Connect Twilio for SMS/MMS and voice. Voice is answered by Clara;
          SMS routes to Clara (auto-reply) or to a user inbox.
        </p>
      </div>
      <TwilioConfig />
    </div>
  );
}
