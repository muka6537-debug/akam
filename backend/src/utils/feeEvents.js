// In-process event bus between the Admission System and the Fee Module.
// Admissions only emits; the fee module subscribes (see services/feeStructure).
const { EventEmitter } = require('events');

const feeEvents = new EventEmitter();
feeEvents.setMaxListeners(20);

const ADMISSION_ANNOUNCED = 'admission:announced';

module.exports = { feeEvents, ADMISSION_ANNOUNCED };
