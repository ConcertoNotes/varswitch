import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMacCredentials, macSigningMode, macBuildEnvironment, verifyApp } from '../scripts/release-build.mjs';

const credentials = {
  APPLE_CERTIFICATE: 'base64-p12',
  APPLE_CERTIFICATE_PASSWORD: 'p12-password',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAM123)',
  APPLE_ID: 'build@example.test',
  APPLE_PASSWORD: 'app-specific-password',
  APPLE_TEAM_ID: 'TEAM123',
};

test('发布前拒绝缺失 Apple 凭据，错误信息不会回显凭据值', () => {
  for (const key of Object.keys(credentials)) {
    const env = { ...credentials };
    delete env[key];
    assert.throws(() => checkMacCredentials(env), (error) => {
      assert.ok(error.message.includes(key));
      assert.ok(!error.message.includes(credentials.APPLE_PASSWORD));
      assert.ok(!error.message.includes(credentials.APPLE_CERTIFICATE_PASSWORD));
      return true;
    });
  }
  assert.doesNotThrow(() => checkMacCredentials(credentials));
  for (const identity of ['-', 'Apple Development: Example (TEAM123)']) {
    assert.throws(() => checkMacCredentials({ ...credentials, APPLE_SIGNING_IDENTITY: identity }));
  }
});

const signed = 'Authority=Developer ID Application: Example (TEAM123)\nTeamIdentifier=TEAM123\nCodeDirectory flags=0x10000(runtime)\n';

test('无证书时使用临时签名，空公证变量必须从构建环境移除', () => {
  const env = Object.fromEntries(Object.keys(credentials).map((key) => [key, '']));
  assert.equal(macSigningMode(env), 'adhoc');
  const build = macBuildEnvironment(env);
  assert.equal(build.APPLE_SIGNING_IDENTITY, '-');
  for (const name of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_CERTIFICATE', 'APPLE_TEAM_ID']) {
    assert.equal(Object.hasOwn(build, name), false);
  }
  assert.equal(macSigningMode(credentials), 'notarized');
  assert.deepEqual(macBuildEnvironment(credentials), credentials);
  assert.throws(() => macSigningMode({ APPLE_ID: credentials.APPLE_ID }));
});

test('临时签名构建必须通过完整性校验，并且不能宣称通过 Apple 公证', () => {
  const calls = [];
  verifyApp('/bundle/VarSwitch.app', undefined, (tool, args) => {
    calls.push(tool);
    return args.includes('--display') ? 'Signature=adhoc\n' : '';
  }, 'adhoc');
  assert.deepEqual(calls, ['/usr/bin/codesign', '/usr/bin/codesign']);
  assert.throws(() => verifyApp('/bundle/VarSwitch.app', undefined, () => '', 'adhoc'));
});

test('发布校验拒绝临时签名、错误 Team 和缺失 Hardened Runtime', () => {
  for (const signature of ['Signature=adhoc', signed.replace('TEAM123\n', 'OTHER\n'), signed.replace('(runtime)', '')]) {
    const calls = [];
    assert.throws(() => verifyApp('/bundle/VarSwitch.app', 'TEAM123', (tool, args) => {
      calls.push([tool, args]);
      return args.includes('--display') ? signature : '';
    }));
    assert.equal(calls.some(([, args]) => args.includes('stapler')), false);
  }
});

test('有效签名还必须通过公证票据和 Gatekeeper 检查', () => {
  const calls = [];
  verifyApp('/bundle/VarSwitch.app', 'TEAM123', (tool, args) => {
    calls.push([tool, args]);
    return args.includes('--display') ? signed : '';
  });
  assert.ok(calls.some(([, args]) => args.includes('--strict')));
  assert.ok(calls.some(([, args]) => args[0] === 'stapler' && args[1] === 'validate'));
  assert.ok(calls.some(([tool, args]) => tool.endsWith('/spctl') && args.includes('--assess')));
  for (const failingTool of ['/usr/bin/codesign', '/usr/bin/xcrun', '/usr/sbin/spctl']) {
    assert.throws(() => verifyApp('/bundle/VarSwitch.app', 'TEAM123', (tool, args) => {
      if (tool === failingTool) throw new Error('rejected');
      return args.includes('--display') ? signed : '';
    }), /rejected/);
  }
});
