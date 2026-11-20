-- Smart Sports Facility Booking System - MySQL 8 schema (11 tables, 3NF, matches Progress I data dictionary)
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS roles (
  role_id INT AUTO_INCREMENT PRIMARY KEY,
  role_name VARCHAR(20) NOT NULL,
  UNIQUE KEY uq_roles_name (role_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  role_id INT NOT NULL,
  student_id VARCHAR(15) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  telegram_chat_id VARCHAR(30) NULL,
  phone VARCHAR(20) NULL,
  faculty VARCHAR(100) NULL,
  photo_url VARCHAR(255) NULL,
  status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_student (student_id),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS facility_types (
  type_id INT AUTO_INCREMENT PRIMARY KEY,
  type_name VARCHAR(50) NOT NULL,
  UNIQUE KEY uq_ftype_name (type_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS facilities (
  facility_id INT AUTO_INCREMENT PRIMARY KEY,
  type_id INT NOT NULL,
  facility_name VARCHAR(100) NOT NULL,
  location VARCHAR(150) NOT NULL,
  capacity INT NULL,
  photo_url VARCHAR(255) NULL,
  status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  UNIQUE KEY uq_facility_name (facility_name),
  CONSTRAINT fk_fac_type FOREIGN KEY (type_id) REFERENCES facility_types(type_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS time_slots (
  slot_id INT AUTO_INCREMENT PRIMARY KEY,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  UNIQUE KEY uq_slot (start_time, end_time)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bookings (
  booking_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  facility_id INT NOT NULL,
  slot_id INT NOT NULL,
  booking_date DATE NOT NULL,
  status ENUM('Confirmed','Cancelled','Completed') NOT NULL DEFAULT 'Confirmed',
  active_key TINYINT GENERATED ALWAYS AS (IF(status = 'Confirmed', 1, NULL)) STORED,
  receipt_url VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at DATETIME NULL,
  -- BR08: only one active (Confirmed) booking per facility, slot and date. NULLs do not collide, so cancelled rows never block a slot.
  UNIQUE KEY uq_no_double_booking (facility_id, slot_id, booking_date, active_key),
  KEY ix_bookings_date_fac (booking_date, facility_id),
  KEY ix_bookings_user_date (user_id, booking_date),
  KEY ix_bookings_status_date (status, booking_date),
  CONSTRAINT fk_book_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_book_fac FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
  CONSTRAINT fk_book_slot FOREIGN KEY (slot_id) REFERENCES time_slots(slot_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS iot_devices (
  device_id INT AUTO_INCREMENT PRIMARY KEY,
  facility_id INT NOT NULL,
  thing_name VARCHAR(100) NOT NULL,
  firmware_version VARCHAR(20) NULL,
  status ENUM('Online','Offline') NOT NULL DEFAULT 'Offline',
  last_seen DATETIME NULL,
  light_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
  UNIQUE KEY uq_device_facility (facility_id),
  UNIQUE KEY uq_device_thing (thing_name),
  CONSTRAINT fk_dev_fac FOREIGN KEY (facility_id) REFERENCES facilities(facility_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- booking_id is NULL for manual admin overrides (a small change from the Progress I dictionary, which listed it as NOT NULL)
CREATE TABLE IF NOT EXISTS light_command_logs (
  command_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NULL,
  device_id INT NOT NULL,
  command_type ENUM('ON','OFF') NOT NULL,
  sent_at DATETIME NOT NULL,
  ack_status ENUM('Pending','Acknowledged','Failed') NOT NULL DEFAULT 'Pending',
  retry_count TINYINT NOT NULL DEFAULT 0,
  ack_at DATETIME NULL,
  KEY ix_cmd_booking (booking_id, command_type),
  KEY ix_cmd_sent (sent_at),
  CONSTRAINT fk_cmd_booking FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE SET NULL,
  CONSTRAINT fk_cmd_device FOREIGN KEY (device_id) REFERENCES iot_devices(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS device_status_logs (
  log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  status ENUM('Online','Offline') NOT NULL,
  recorded_at DATETIME NOT NULL,
  KEY ix_dsl_device (device_id, recorded_at),
  CONSTRAINT fk_dsl_device FOREIGN KEY (device_id) REFERENCES iot_devices(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  notification_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  booking_id INT NULL,
  type ENUM('Confirmation','CourtReady','Cancellation') NOT NULL,
  message VARCHAR(255) NOT NULL,
  status ENUM('Sent','Failed','Skipped') NOT NULL,
  sent_at DATETIME NULL,
  KEY ix_notif_user (user_id, sent_at),
  KEY ix_notif_booking (booking_id, type),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_notif_booking FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action VARCHAR(50) NOT NULL,
  entity VARCHAR(50) NULL,
  entity_id INT NULL,
  ip_address VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_created (created_at),
  KEY ix_audit_user (user_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Helper tables (not part of the 11-table ERD): one-time Telegram link codes and small app settings
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code VARCHAR(16) PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at DATETIME NOT NULL,
  KEY ix_tlc_user (user_id),
  CONSTRAINT fk_tlc_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(50) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

-- ---------- Seed data (idempotent). Courts and devices are seeded from db/init.js ----------
INSERT IGNORE INTO roles (role_name) VALUES ('Student'), ('Admin');

INSERT IGNORE INTO facility_types (type_name) VALUES
  ('Badminton'), ('Netball'), ('Football'), ('Basketball'), ('Sepak Takraw'), ('Volleyball'),
  ('Tennis'), ('Softball'), ('Floorball'), ('Table Tennis'), ('Futsal'), ('Gymnasium');

INSERT IGNORE INTO time_slots (start_time, end_time) VALUES
  ('08:00:00','09:00:00'), ('09:00:00','10:00:00'), ('10:00:00','11:00:00'), ('11:00:00','12:00:00'),
  ('12:00:00','13:00:00'), ('13:00:00','14:00:00'), ('14:00:00','15:00:00'), ('15:00:00','16:00:00'),
  ('16:00:00','17:00:00'), ('17:00:00','18:00:00'), ('18:00:00','19:00:00'), ('19:00:00','20:00:00'),
  ('20:00:00','21:00:00'), ('21:00:00','22:00:00');
