// Modal de resolução de conflito quando aparelho e nuvem possuem progresso diferente.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { sfx } from '../../game/audio.ts';
import { useGame } from '../../game/store.ts';
import type { MigrationSummary } from '../../game/types.ts';
import { mapAuthError } from '../../services/auth.ts';
import { resolveMigrationCloudOnly, resolveMigrationMerge } from '../../services/migration.ts';
import { C } from '../theme.ts';
import { Arcade, Muted, PxBox, PxButton, PxCell, Txt } from './Px.tsx';

function SummaryColumn({ title, summary, accent }: { title: string; summary: MigrationSummary; accent: string }) {
  return (
    <PxCell style={styles.col}>
      <Arcade size={10} spacing={0} color={accent}>
        {title}
      </Arcade>
      {summary.displayName && (
        <Txt size={13} weight={700} numberOfLines={1}>
          {summary.displayName}
        </Txt>
      )}
      <Txt size={13} color={C.muted}>
        Atividades: <Txt weight={700}>{summary.activities}</Txt>
      </Txt>
      <Txt size={13} color={C.muted}>
        Células: <Txt weight={700}>{summary.cells.toLocaleString('pt-BR')}</Txt>
      </Txt>
      <Txt size={13} color={C.muted}>
        Capturas: <Txt weight={700}>{summary.captures}</Txt>
      </Txt>
      <Txt size={13} color={C.muted}>
        XP: <Txt weight={700}>{summary.xp.toLocaleString('pt-BR')}</Txt>
      </Txt>
    </PxCell>
  );
}

export function MigrationModal({ onClose }: { onClose: () => void }) {
  const pendingMigration = useGame((s) => s.pendingMigration);
  const toast = useGame((s) => s.toast);
  const [busy, setBusy] = useState<'merge' | 'cloud' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!pendingMigration) {
    return (
      <View style={styles.wrap}>
        <Arcade size={16} weight={700} spacing={0} align="center" color={C.gold}>
          SINCRONIZAÇÃO
        </Arcade>
        <Muted size={14} align="center">
          Nenhum conflito pendente no momento.
        </Muted>
        <PxButton onPress={onClose}>Fechar</PxButton>
      </View>
    );
  }

  const handleMerge = async () => {
    if (busy) return;
    sfx.click();
    setErrorMsg(null);
    setBusy('merge');
    try {
      await resolveMigrationMerge();
      toast('Progresso mesclado com a nuvem!', 'info');
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleCloudOnly = async () => {
    if (busy) return;
    sfx.click();
    setErrorMsg(null);
    setBusy('cloud');
    try {
      await resolveMigrationCloudOnly();
      toast('Dados locais substituídos pela nuvem.', 'info');
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.wrap}>
      <Arcade
        size={17}
        weight={700}
        spacing={0}
        lh={1.4}
        align="center"
        color={C.gold}
        shadow={{ y: 3 }}
        accessibilityRole="header"
      >
        CONFLITO DE DADOS
      </Arcade>

      <Muted size={14} align="center">
        Encontramos progresso salvo neste aparelho e também na sua conta
        {pendingMigration.email ? ` (${pendingMigration.email})` : ''}. Como deseja continuar?
      </Muted>

      <View style={styles.cols}>
        <SummaryColumn title="ESTE APARELHO" summary={pendingMigration.local} accent={C.sky} />
        <SummaryColumn title="NUVEM" summary={pendingMigration.cloud} accent={C.mint} />
      </View>

      {errorMsg && (
        <PxBox bg={C.coral} drop={false} style={styles.banner}>
          <Txt size={13} weight={700} color={C.cream}>
            {errorMsg}
          </Txt>
        </PxBox>
      )}

      <View style={styles.actions}>
        <PxButton
          variant="gold"
          block
          disabled={busy !== null}
          onPress={() => void handleMerge()}
          testID="migration-merge-btn"
        >
          {busy === 'merge' ? 'Mesclando…' : 'Mesclar progresso'}
        </PxButton>

        <PxButton
          variant="coral"
          block
          disabled={busy !== null}
          onPress={() => void handleCloudOnly()}
          testID="migration-cloud-only-btn"
        >
          {busy === 'cloud' ? 'Carregando nuvem…' : 'Manter apenas a nuvem'}
        </PxButton>

        <PxButton size="small" variant="ghost" block disabled={busy !== null} onPress={onClose}>
          Decidir depois
        </PxButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  cols: { flexDirection: 'row', gap: 10 },
  col: { flex: 1, minWidth: 0, gap: 4, paddingVertical: 10, paddingHorizontal: 10 },
  banner: { paddingVertical: 10, paddingHorizontal: 12 },
  actions: { gap: 10 },
});
