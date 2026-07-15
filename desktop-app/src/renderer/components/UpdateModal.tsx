import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import s from './UpdateModal.module.scss';

interface UpdateInfo {
  version: string;
  type: 'minor' | 'major';
  downloadUrl: string;
  releaseNotes: string;
  size: number;
}

type UpdateStatus = 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';

interface Props {
  info: UpdateInfo;
  onClose: () => void;
}

const electronAPI = (window as any).electronAPI;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, y: 16, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: 16, scale: 0.97, transition: { duration: 0.15 } },
};

export function UpdateModal({ info, onClose }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>('available');
  const [progress, setProgress] = useState(0);
  const [transferred, setTransferred] = useState(0);
  const [total, setTotal] = useState(0);
  const [tempPath, setTempPath] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Listen for download progress
  useEffect(() => {
    if (!electronAPI) return;
    return electronAPI.onUpdateProgress((data: { percent: number; transferred: number; total: number }) => {
      setProgress(data.percent);
      setTransferred(data.transferred);
      setTotal(data.total);
    });
  }, []);

  const handleDownload = useCallback(async () => {
    if (!electronAPI) return;
    setStatus('downloading');
    setProgress(0);
    setErrorMsg('');

    const result = await electronAPI.updateDownload(info.downloadUrl);

    if (result.error) {
      setStatus('error');
      setErrorMsg(result.error);
      return;
    }

    setTempPath(result.tempPath);
    setStatus('downloaded');
  }, [info.downloadUrl]);

  const handleInstall = useCallback(async () => {
    if (!electronAPI || !tempPath) return;

    setStatus('installing');
    setErrorMsg('');

    const result = info.type === 'minor'
      ? await electronAPI.updateInstallMinor(tempPath)
      : await electronAPI.updateInstallMajor(tempPath);

    if (result?.error) {
      setStatus('error');
      setErrorMsg(result.error);
    }
  }, [info.type, tempPath]);

  const isMinor = info.type === 'minor';
  const sizeLabel = info.size > 0 ? formatBytes(info.size) : '';

  return (
    <AnimatePresence>
      <motion.div
        className={s.overlay}
        variants={overlayVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <motion.div
          className={s.modal}
          variants={modalVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          {/* Header */}
          <div className={s.header}>
            <div className={s.titleSection}>
              <div className={s.title}>
                {t('update.available', { version: info.version })}
              </div>
              <div className={`${s.badge} ${isMinor ? s.minor : s.major}`}>
                {isMinor ? t('update.quick') : t('update.full')}
              </div>
            </div>
            <button className={s.closeBtn} onClick={onClose} aria-label={t('common.close')}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Release notes */}
          {info.releaseNotes && (
            <div className={s.releaseNotes}>{info.releaseNotes}</div>
          )}

          {/* Size info */}
          {sizeLabel && status === 'available' && (
            <div className={s.sizeInfo}>
              {t('update.downloadSize', { size: sizeLabel })}
              {!isMinor && t('update.reinstallRequired')}
            </div>
          )}

          {/* Progress */}
          {(status === 'downloading' || status === 'downloaded' || status === 'installing') && (
            <div className={s.progressSection}>
              <div className={s.progressBar}>
                <div
                  className={s.progressFill}
                  style={{ width: `${status === 'downloaded' ? 100 : progress}%` }}
                />
              </div>
              <div className={s.progressText}>
                <span>
                  {status === 'downloaded'
                    ? t('update.downloadComplete')
                    : status === 'installing'
                      ? t('update.restarting')
                      : `${progress}% • ${formatBytes(transferred)} / ${formatBytes(total || info.size)}`}
                </span>
              </div>
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className={s.errorText}>
              {t('update.downloadError', { error: errorMsg })}
            </div>
          )}

          {/* Actions */}
          <div className={s.actions}>
            {status === 'available' && (
              <>
                <button className={`${s.btn} ${s.btnSecondary}`} onClick={onClose}>
                  {t('common.later')}
                </button>
                <button className={`${s.btn} ${s.btnPrimary}`} onClick={handleDownload}>
                  {t('common.download')}
                </button>
              </>
            )}

            {status === 'downloading' && (
              <button className={`${s.btn} ${s.btnSecondary}`} disabled>
                {t('common.downloading')}
              </button>
            )}

            {status === 'installing' && (
              <button className={`${s.btn} ${s.btnSecondary}`} disabled>
                {t('update.restarting')}
              </button>
            )}

            {status === 'downloaded' && (
              <>
                <button className={`${s.btn} ${s.btnSecondary}`} onClick={onClose}>
                  {t('common.later')}
                </button>
                <button className={`${s.btn} ${s.btnDanger}`} onClick={handleInstall}>
                  {isMinor ? t('update.restartAndUpdate') : t('update.install')}
                </button>
              </>
            )}

            {status === 'error' && (
              <button className={`${s.btn} ${s.btnSecondary}`} onClick={onClose}>
                {t('common.close')}
              </button>
            )}
          </div>

          {/* Current version */}
          <div className={s.versionInfo}>
            {t('update.currentVersion', { version: electronAPI?.appVersion || '—' })}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
