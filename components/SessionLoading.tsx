import styles from "./SessionLoading.module.css";

export function SessionLoading() {
  return (
    <div className={styles.loading} role="status" aria-label="正在加载会话" aria-busy="true">
      <div className={styles.content} aria-hidden="true">
        <div className={styles.preview}>
          <div className={`${styles.bubble} ${styles.user}`}><span /><span /></div>
          <div className={`${styles.bubble} ${styles.assistant}`}><span /><span /><span /></div>
          <div className={`${styles.bubble} ${styles.reply}`}><span /></div>
        </div>
        <div className={styles.caption}>
          正在加载会话<span className={styles.dots}><i /><i /><i /></span>
        </div>
      </div>
    </div>
  );
}
