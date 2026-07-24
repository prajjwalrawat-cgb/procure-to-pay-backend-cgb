import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AudienceController } from './audience.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, AudienceController],
  providers: [AuthService, TokenService],
  exports: [TokenService, AuthService],
})
export class AuthModule {}
