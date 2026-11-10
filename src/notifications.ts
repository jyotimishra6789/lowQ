export interface Notification {
  restaurantId: string;
  tokenId: string;
  channel: 'sms' | 'whatsapp';
  message: string;
}

export interface NotificationService {
  send(notification: Notification): Promise<void>;
}

export class StructuredLogNotificationService implements NotificationService {
  async send(notification: Notification): Promise<void> {
    console.log(JSON.stringify({ event: 'notification.sent', ...notification }));
  }
}

export class WebhookNotificationService implements NotificationService {
  constructor(
    private readonly url: string,
    private readonly authorization?: string
  ) {}

  async send(notification: Notification): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.authorization ? { authorization: this.authorization } : {})
      },
      body: JSON.stringify(notification)
    });
    if (!response.ok) {
      throw new Error(`Notification webhook failed with status ${response.status}`);
    }
  }
}

export function createNotificationService(): NotificationService {
  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  return url
    ? new WebhookNotificationService(url, process.env.NOTIFICATION_WEBHOOK_AUTH)
    : new StructuredLogNotificationService();
}
