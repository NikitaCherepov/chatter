import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { Announcement } from '../lib/announcements';
import s from './OnboardingModal.module.scss';

type Props = {
  announcements: Announcement[];
  onDone: (seenIds: string[]) => void;
};

const OVERLAY_VARIANTS = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const MODAL_VARIANTS = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
};

const SLIDE_VARIANTS = {
  enter: { opacity: 0, x: 24 },
  center: { opacity: 1, x: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, x: -24, transition: { duration: 0.15 } },
};

export function OnboardingModal({ announcements, onDone }: Props) {
  const { t } = useTranslation();

  const [annIdx, setAnnIdx] = useState(0);
  const [slideIdx, setSlideIdx] = useState(0);

  const currentAnnouncement = announcements[annIdx];
  const currentSlide = currentAnnouncement?.slides[slideIdx];

  const totalSlides = currentAnnouncement
    ? currentAnnouncement.slides.length
    : 0;

  const isFirstSlide = slideIdx === 0 && annIdx === 0;
  const isLastSlide =
    annIdx === announcements.length - 1 &&
    slideIdx === totalSlides - 1;

  const goNext = useCallback(() => {
    if (!currentAnnouncement) return;
    if (slideIdx < totalSlides - 1) {
      setSlideIdx((s) => s + 1);
    } else if (annIdx < announcements.length - 1) {
      setAnnIdx((a) => a + 1);
      setSlideIdx(0);
    }
  }, [annIdx, slideIdx, totalSlides, announcements.length, currentAnnouncement]);

  const goBack = useCallback(() => {
    if (slideIdx > 0) {
      setSlideIdx((s) => s - 1);
    } else if (annIdx > 0) {
      const prev = announcements[annIdx - 1];
      setAnnIdx((a) => a - 1);
      setSlideIdx(prev.slides.length - 1);
    }
  }, [annIdx, slideIdx, announcements]);

  const handleDone = useCallback(() => {
    onDone(announcements.map((a) => a.id));
  }, [announcements, onDone]);

  if (!currentSlide) return null;

  return (
    <motion.div
      className={s.overlay}
      variants={OVERLAY_VARIANTS}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        variants={MODAL_VARIANTS}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        {/* Header */}
        <div className={s.header}>
          <span className={s.title} />
          {isLastSlide && (
            <button className={s.closeBtn} onClick={handleDone} aria-label={t('common.close')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Body */}
        <div className={s.body}>
          <AnimatePresence mode="wait">
            <motion.div
              key={`${currentSlide.id}`}
              className={s.slideContent}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {currentSlide.image && (
                <div className={s.imageWrap}>
                  <img className={s.image} src={currentSlide.image} alt="" />
                </div>
              )}

              <div className={s.slideTitle}>
                <MarkdownRenderer content={t(currentSlide.titleKey)} />
              </div>

              <div className={s.slideBody}>
                <MarkdownRenderer content={t(currentSlide.bodyKey)} />
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className={s.footer}>
          <span className={s.stepIndicator}>
            {t('onboarding.stepIndicator', {
              current: slideIdx + 1,
              total: totalSlides,
            })}
          </span>
          <div className={s.navRow}>
            <div>
              {!isFirstSlide && (
                <button className={s.navBtn} onClick={goBack}>
                  {t('onboarding.back')}
                </button>
              )}
            </div>
            {isLastSlide ? (
              <button className={s.primaryBtn} onClick={handleDone}>
                {t('onboarding.done')}
              </button>
            ) : (
              <button className={s.primaryBtn} onClick={goNext}>
                {t('onboarding.next')}
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
