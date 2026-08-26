import assert from 'node:assert/strict';

const sshCommandModule = await import('../src/services/ssh-command.ts') as any;
const { prepareCommandForSudoPassword } = sshCommandModule.default ?? sshCommandModule;

const simple = prepareCommandForSudoPassword('sudo echo "SUDO_WORKS"');
assert.equal(simple.needsPassword, true);
assert.equal(simple.command, 'sudo -S -p \'\' echo "SUDO_WORKS"');

const chained = prepareCommandForSudoPassword(
  'cd /var/www/my-portfolio && sudo -u postgres pg_dump -Fc portfolio_database',
);
assert.equal(chained.needsPassword, true);
assert.equal(
  chained.command,
  'cd /var/www/my-portfolio && sudo -S -p \'\' -u postgres pg_dump -Fc portfolio_database',
);

const multiple = prepareCommandForSudoPassword(
  'sudo -u postgres pg_dump -f /tmp/db.dump && sudo cp /tmp/db.dump /srv/db.dump && sudo rm /tmp/db.dump',
);
assert.equal(multiple.needsPassword, true);
assert.match(multiple.command, /^sudo -S -p '' -u postgres/);
assert.match(multiple.command, /&& sudo cp/);
assert.match(multiple.command, /&& sudo rm/);

const nonInteractive = prepareCommandForSudoPassword(
  'sudo -n true 2>&1 && echo "SUDO_OK_NOPASS" || echo "SUDO_NEEDS_PASSWORD"',
);
assert.equal(nonInteractive.needsPassword, false);
assert.equal(
  nonInteractive.command,
  'sudo -n true 2>&1 && echo "SUDO_OK_NOPASS" || echo "SUDO_NEEDS_PASSWORD"',
);

console.log('ssh command wrapper tests passed');
