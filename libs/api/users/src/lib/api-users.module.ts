import { Module } from '@nestjs/common';
import { ApiAuthModule } from '@raijin/api-auth';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [ApiAuthModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class ApiUsersModule {}
