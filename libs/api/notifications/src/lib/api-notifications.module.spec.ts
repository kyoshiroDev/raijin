import { Test } from '@nestjs/testing';
import { ApiNotificationsModule } from './api-notifications.module';

describe('ApiNotificationsModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiNotificationsModule] }).compile();
    expect(moduleRef.get(ApiNotificationsModule)).toBeInstanceOf(ApiNotificationsModule);
    await moduleRef.close();
  });
});
