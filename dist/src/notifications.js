export class StructuredLogNotificationService {
    async send(notification) {
        console.log(JSON.stringify({ event: 'notification.sent', ...notification }));
    }
}
export class WebhookNotificationService {
    url;
    authorization;
    constructor(url, authorization) {
        this.url = url;
        this.authorization = authorization;
    }
    async send(notification) {
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
export function createNotificationService() {
    const url = process.env.NOTIFICATION_WEBHOOK_URL;
    return url
        ? new WebhookNotificationService(url, process.env.NOTIFICATION_WEBHOOK_AUTH)
        : new StructuredLogNotificationService();
}
